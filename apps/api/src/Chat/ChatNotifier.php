<?php

declare(strict_types=1);

namespace App\Chat;

use App\Entity\Chat;
use App\Entity\ChatAccount;
use App\Entity\ChatMessage;
use App\Enum\NotificationChannel;
use App\Enum\NotificationKind;
use App\Notification\CalendarPresence;
use App\Notification\Channel\PushMessage;
use App\Notification\NotificationChannelChoice;
use App\Notification\NotificationDispatcher;
use App\Notification\QuietHours;
use App\Realtime\AfterCommitDispatcher;
use App\Repository\NotificationPreferencesRepository;
use Doctrine\ORM\EntityManagerInterface;
use Symfony\Component\Messenger\Attribute\AsMessageHandler;
use Symfony\Component\Messenger\Stamp\DelayStamp;
use Symfony\Component\Uid\Uuid;

/**
 * Pushes a new WhatsApp message to the user's phone, only while the account's Notify me is on (off by default: the
 * phone already notifies through WhatsApp). The push names the chat and nothing else: title `WhatsApp`, body the chat's
 * name opened from its seal, or `New WhatsApp message` for a chat without one and for a chat whose name is a phone
 * number (the bridge names a chat with an unsaved contact by its number); never the text, a sender or a number.
 *
 * The relay's batch hands over each chat's newest incoming message it stored ({@see stored()}), in the batch's
 * transaction, unless the server took the batch as part of a first import (the history the relay found). The push is
 * decided after the commit and {@see COALESCE_MS} later: a message defers to a newer incoming one of its chat (ordered
 * by time, then id), so a burst notifies once, but only while the oldest message the chat has not been pushed for is
 * younger than {@see MAX_WAIT_SECONDS}: a chat that keeps getting messages is pushed at least that often. A message sent
 * before the chat's last push is not pushed again (that push named the chat). Nothing is pushed for
 * the user's own messages, a message older than {@see FRESH} when it is decided, a chat read through it meanwhile (on
 * another device) or left out, or once Notify me went off.
 *
 * It goes to the phone only, keyed "whatsapp:{message}" so a repeated delivery never notifies twice; quiet hours and
 * busy events (focusDuringBusy) make it silent, on the `whatsapp_silent` channel. A user who chose no phone for the
 * `whatsapp` kind gets none. A failed delivery is not sent again by a sweep: a chat push is stale within minutes.
 */
final readonly class ChatNotifier
{
    /** A message older than this when its push is decided is no news. */
    public const string FRESH = '15 minutes';
    /** How long a push waits for more messages of its chat. */
    public const int COALESCE_MS = 10_000;
    /** The longest a chat that keeps getting messages goes without a push. */
    public const int MAX_WAIT_SECONDS = 60;
    /** The body of a push for a chat without a name, or named by a number: no number leaves the server. */
    public const string NO_NAME = 'New WhatsApp message';
    /** A name that is a phone number as the bridge or a contact list writes one. */
    private const string NUMBER = '/^\+?[\d\s().\-]{5,}$/D';
    /** How long push services keep trying. */
    private const string EXPIRES = '+1 hour';

    public function __construct(
        private EntityManagerInterface $entityManager,
        private NotificationPreferencesRepository $preferences,
        private NotificationDispatcher $dispatcher,
        private CalendarPresence $presence,
        private AfterCommitDispatcher $afterCommit,
        private ChatFields $fields,
    ) {
    }

    /**
     * Called by the ingestor in the relay's transaction with the newest incoming message each chat got in a batch.
     * `$firstImport` is the server's decision for the batch (ChatIngestor's honoured flag), not the relay's flag alone.
     *
     * @param list<ChatMessage> $newest
     */
    public function stored(ChatAccount $account, array $newest, bool $firstImport, \DateTimeImmutable $now): void
    {
        if ($firstImport || !$account->notifies()) {
            return;
        }
        foreach ($newest as $message) {
            if (!$message->isFromMe() && self::fresh($message, $now)) {
                $this->afterCommit->dispatch(new NotifyChatMessage($message->getId()->toRfc4122()), [new DelayStamp(self::COALESCE_MS)]);
            }
        }
    }

    #[AsMessageHandler]
    public function onNotify(NotifyChatMessage $message): void
    {
        $this->deliver($message->messageId, new \DateTimeImmutable());
    }

    public function deliver(string $messageId, \DateTimeImmutable $now): void
    {
        if (!Uuid::isValid($messageId)) {
            return;
        }
        try {
            $message = $this->entityManager->find(ChatMessage::class, Uuid::fromString($messageId));
            // Gone with its chat left out, its account or the user.
            if (!$message instanceof ChatMessage || $message->isFromMe() || !self::fresh($message, $now)) {
                return;
            }
            $chat = $message->getChat();
            $account = $chat->getChatAccount();
            $read = $chat->getReadThrough();
            if (!$account->notifies() || $chat->isLeftOut() || (null !== $read && $read >= $message->getSentAt())) {
                return;
            }
            $pushed = $this->lastPush($chat, $now);
            if (null !== $pushed && $pushed >= self::local($message->getSentAt())) {
                // A push of the chat after this message came told of it: a push names the chat, not the message.
                return;
            }
            if ($this->newerIncoming($message) && $this->waitedLessThanMax($chat, $pushed, $now)) {
                // The newer message's own push comes, and the chat has not waited long.
                return;
            }
            $owner = $account->getOwner();
            $preferences = $this->preferences->forUser($owner);
            if (!$preferences->channelsFor(NotificationKind::WhatsApp->value, NotificationKind::WhatsApp->defaultChannels())->includes(NotificationChannel::Phone)) {
                return;
            }
            $silent = null !== QuietHours::endOf($preferences, $now)
                || ($preferences->isFocusDuringBusy() && $this->presence->inBusyEvent($owner, $now));
            $chatId = $chat->getId()->toRfc4122();
            $this->dispatcher->send(
                $owner,
                new PushMessage($messageId, NotificationKind::WhatsApp->value, 'WhatsApp', $this->body($chat), '/chats/'.$chatId, $silent, $now->modify(self::EXPIRES), ['chatId' => $chatId], PushMessage::WHATSAPP),
                self::deliveryKey($messageId),
                new NotificationChannelChoice(NotificationChannel::Phone),
                $now,
            );
        } finally {
            $this->entityManager->clear();
        }
    }

    public static function deliveryKey(string $messageId): string
    {
        return 'whatsapp:'.$messageId;
    }

    /** The chat's name as the relay stored it; {@see NO_NAME} for none, or for a name that is a phone number. */
    private function body(Chat $chat): string
    {
        return self::bodyFor($this->fields->name($chat));
    }

    /** What a push says for a chat of this name. */
    public static function bodyFor(#[\SensitiveParameter] ?string $name): string
    {
        $name = trim((string) $name);

        return '' === $name || 1 === preg_match(self::NUMBER, $name) ? self::NO_NAME : $name;
    }

    /** An incoming message of the chat after this one: a later time, or the same second and a later id. */
    private function newerIncoming(ChatMessage $message): bool
    {
        return false !== $this->entityManager->getConnection()->fetchOne(
            'SELECT 1 FROM chat_message WHERE chat_id = :chat AND from_me = false AND (sent_at > CAST(:at AS TIMESTAMP) OR (sent_at = CAST(:at AS TIMESTAMP) AND id > CAST(:id AS UUID))) LIMIT 1',
            ['chat' => $message->getChat()->getId()->toRfc4122(), 'at' => self::local($message->getSentAt()), 'id' => $message->getId()->toRfc4122()],
        );
    }

    /**
     * When the chat was last pushed: the newest delivery of one of its fresh incoming messages (so no column is needed);
     * null when none was.
     */
    private function lastPush(Chat $chat, \DateTimeImmutable $now): ?string
    {
        $pushed = $this->entityManager->getConnection()->fetchOne(
            "SELECT MAX(d.created_at) FROM chat_message m JOIN notification_delivery d ON d.delivery_key = 'whatsapp:' || CAST(m.id AS TEXT)
             WHERE m.chat_id = :chat AND m.from_me = false AND m.sent_at >= CAST(:fresh AS TIMESTAMP)",
            ['chat' => $chat->getId()->toRfc4122(), 'fresh' => self::local($now->modify('-'.self::FRESH))],
        );

        return \is_string($pushed) ? $pushed : null;
    }

    /**
     * Whether the oldest fresh incoming message the chat was not pushed for (after its last push and its read) is younger
     * than {@see MAX_WAIT_SECONDS}: then a message may wait for the push of a newer one.
     */
    private function waitedLessThanMax(Chat $chat, ?string $pushed, \DateTimeImmutable $now): bool
    {
        $from = self::local($now->modify('-'.self::FRESH));
        $read = $chat->getReadThrough();
        foreach ([$pushed, null === $read ? null : self::local($read)] as $later) {
            if (null !== $later && $later > $from) {
                $from = $later;
            }
        }
        $oldest = $this->entityManager->getConnection()->fetchOne(
            'SELECT MIN(sent_at) FROM chat_message WHERE chat_id = :chat AND from_me = false AND sent_at > CAST(:from AS TIMESTAMP)',
            ['chat' => $chat->getId()->toRfc4122(), 'from' => $from],
        );

        return !\is_string($oldest) || $oldest > self::local($now->modify(\sprintf('-%d seconds', self::MAX_WAIT_SECONDS)));
    }

    /** A time as the database keeps it (the default time zone, whole seconds), comparable as text. */
    private static function local(\DateTimeImmutable $time): string
    {
        return $time->setTimezone(new \DateTimeZone(date_default_timezone_get()))->format('Y-m-d H:i:s');
    }

    private static function fresh(ChatMessage $message, \DateTimeImmutable $now): bool
    {
        return $message->getSentAt() >= $now->modify('-'.self::FRESH);
    }
}
