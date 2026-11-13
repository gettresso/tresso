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
 * name opened from its seal (`New WhatsApp message` for a chat without one), never the text, a sender or a number.
 *
 * The relay's batch hands over each chat's newest incoming message it stored ({@see stored()}), in the batch's
 * transaction; the push is decided after the commit and a little later ({@see COALESCE_MS}), so a burst in one chat
 * notifies once: a message is not pushed when a newer incoming one of its chat is stored by then (that one is). Nothing
 * is pushed for a first import (the history the relay found), for the user's own messages, for a message older than
 * {@see FRESH}, for a chat read through it meanwhile (on another device) or left out, or once Notify me went off.
 *
 * It goes to the phone only, keyed "whatsapp:{message}" so a repeated delivery never notifies twice; quiet hours and
 * busy events (focusDuringBusy) make it silent, on the `whatsapp_silent` channel. A user who chose no phone for the
 * `whatsapp` kind gets none.
 */
final readonly class ChatNotifier
{
    /** A message older than this when its push is decided is no news. */
    public const string FRESH = '15 minutes';
    /** How long a push waits for more messages of its chat. */
    public const int COALESCE_MS = 10_000;
    /** The body of a push for a chat without a name: no number or other detail of it leaves the server. */
    public const string NO_NAME = 'New WhatsApp message';
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
            if (!$account->notifies() || $chat->isLeftOut() || (null !== $read && $read >= $message->getSentAt()) || $this->newerIncoming($message)) {
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

    /** The chat's name as the relay stored it, or {@see NO_NAME}. */
    private function body(Chat $chat): string
    {
        $name = trim((string) $this->fields->name($chat));

        return '' === $name ? self::NO_NAME : $name;
    }

    private function newerIncoming(ChatMessage $message): bool
    {
        return [] !== $this->entityManager->createQuery('SELECT m.id FROM App\Entity\ChatMessage m WHERE m.chat = :chat AND m.fromMe = false AND m.sentAt > :at')
            ->setParameter('chat', $message->getChat())
            ->setParameter('at', $message->getSentAt())
            ->setMaxResults(1)
            ->getResult();
    }

    private static function fresh(ChatMessage $message, \DateTimeImmutable $now): bool
    {
        return $message->getSentAt() >= $now->modify('-'.self::FRESH);
    }
}
