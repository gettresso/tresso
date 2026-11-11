<?php

declare(strict_types=1);

namespace App\Notification;

use App\Entity\MailNotification;
use App\Entity\Message;
use App\Entity\NotificationDelivery;
use App\Entity\NotificationDevice;
use App\Entity\User;
use App\Enum\NotificationKind;
use App\Enum\Verdict;
use App\Mail\MessageFields;
use App\Notification\Channel\PushMessage;
use App\Realtime\AfterCommitDispatcher;
use App\Repository\NotificationPreferencesRepository;
use Doctrine\DBAL\LockMode;
use Doctrine\ORM\EntityManagerInterface;
use Doctrine\Persistence\ManagerRegistry;
use Psr\Log\LoggerInterface;
use Symfony\Component\Messenger\Attribute\AsMessageHandler;
use Symfony\Component\Messenger\Stamp\DelayStamp;
use Symfony\Component\Uid\Uuid;

/**
 * Notifies the user of new mail that needs them: a message classified for the first time as `do` or `delegate`, unread,
 * in an inbox, and received recently (an account's history being fetched is not news). Classification calls
 * {@see consider()} in its own transaction, which keeps one {@see MailNotification} per message, so a message notifies
 * at most once, whatever runs again.
 *
 * Delivery happens after that commit, under a lock on the notification: the message must still need the user
 * ({@see needsTheUser()}); a focus block (holdDuringFocus) or a meeting (holdMailInMeetings) makes it wait
 * for their end, quiet hours and other busy events (focusDuringBusy) make it silent. It goes out on the channels the
 * user chose for mail (channelsByKind, else phone and desktop) through the {@see NotificationDispatcher}, keyed
 * "mail:{notification}", claimed in the transaction that marks it delivered. The sweep delivers what a lost message
 * missed and sends failed deliveries again.
 */
final readonly class MailNotifier
{
    /** Mail received longer ago than this when it is classified is not news. */
    public const string FRESH = '1 hour';
    /** A batch that delivers more mail that needs the user than this notifies once, with how many. */
    public const int SUMMARY_AFTER = 3;
    /** Where a tap on a summary leads in every client: the batches (mailNotificationPath and BATCHES_PATH in core). */
    public const string BATCHES_PATH = '/batches';
    /** Nothing is delivered later than this after its fire time, nor sent again after a failure. */
    public const string MAX_LATE = '2 hours';
    /** A notification is only delivered this close to its fire time; a later one is waiting for its own message. */
    private const int EARLY_SECONDS = 30;
    /** How long push services keep trying. */
    private const string EXPIRES = '+2 hours';
    private const int SWEEP_BATCH = 200;
    /** A notification whose delivery failed is tried again after this. */
    private const string FIRE_BACKOFF = '+5 minutes';

    public function __construct(
        private EntityManagerInterface $entityManager,
        private NotificationPreferencesRepository $preferences,
        private NotificationDispatcher $dispatcher,
        private CalendarPresence $presence,
        private AfterCommitDispatcher $afterCommit,
        private ManagerRegistry $managers,
        private LoggerInterface $logger,
        private MessageFields $fields,
    ) {
    }

    /**
     * Called by classification, in its transaction, with the messages it classified for the first time: new mail.
     * Classification that runs again (rules or a correction changed) never comes here: that mail is not new, and a
     * settings change would otherwise push a burst of it. Plans a notification for each message that needs the user
     * and was received recently. The same mail in two of the user's accounts (one Message-ID) notifies once: the
     * copies after the first get a notification that is dropped at once, so they never notify later either.
     *
     * @param list<Message> $classified
     */
    public function consider(User $user, array $classified, \DateTimeImmutable $now): void
    {
        $this->plan($user, array_values(array_filter($classified, static fn (Message $message): bool => $message->getReceivedAt() >= $now->modify('-'.self::FRESH))), $now);
    }

    /**
     * Called when a batch delivers held mail, in that transaction: it was new when it arrived, and its notification
     * waited with it. Plans one for each message that needs the user now, however long ago it was received; mail
     * notified before is not notified again. More than {@see SUMMARY_AFTER} become one notification that says how
     * many ("5 new messages to do"); the others are planned and dropped at once, so they never notify later either. Mail the user's own doing delivers early never comes here, as
     * classification that runs again never does.
     *
     * @param list<Message> $released
     */
    public function released(User $user, array $released, \DateTimeImmutable $now): void
    {
        $this->plan($user, $released, $now, summarize: true);
    }

    /**
     * @param list<Message> $fresh
     */
    private function plan(User $user, array $fresh, \DateTimeImmutable $now, bool $summarize = false): void
    {
        if ([] === $fresh) {
            return;
        }
        /** @var list<string> $notified */
        $notified = $this->entityManager->getConnection()->fetchFirstColumn(
            'SELECT message_id FROM mail_notification WHERE message_id = ANY(CAST(:ids AS UUID[]))',
            ['ids' => '{'.implode(',', array_map(static fn (Message $message): string => $message->getId()->toRfc4122(), $fresh)).'}'],
        );
        // Without previews no sender, subject or text is kept, also in notifications that wait, are dropped or deduped.
        $previews = $this->preferences->forUser($user)->isMailPreviews();
        $headers = [];
        /** @var list<array{MailNotification, Message}> $planned */
        $planned = [];
        foreach ($fresh as $message) {
            // Classification holds the user's lock, so no other run plans the same message meanwhile.
            if (\in_array($message->getId()->toRfc4122(), $notified, true) || !$this->needsTheUser($message)) {
                continue;
            }
            $notification = new MailNotification($user, $message, self::title($message), $now);
            $this->fields->sealNotificationBody($notification, $previews ? $this->body($message) : '');
            if (!$previews) {
                $notification->hideContent(self::withoutContent($message));
            }
            $this->entityManager->persist($notification);
            // The same mail has the same Message-ID and sender; a different mail that reuses a Message-ID notifies.
            $header = $message->getMessageIdHeader();
            $key = null === $header ? null : $header."\n".$message->getFromAddress();
            if (null !== $header && null !== $key && (isset($headers[$key]) || $this->notifiedRecently($user, $header, $message->getFromAddress(), $now))) {
                $notification->drop($now);
                continue;
            }
            if (null !== $key) {
                $headers[$key] = true;
            }
            $planned[] = [$notification, $message];
        }
        if ($summarize && \count($planned) > self::SUMMARY_AFTER) {
            $planned = [$this->summary($planned, $previews, $now)];
        }
        foreach ($planned as [$notification]) {
            $this->afterCommit->dispatch(new SendMailNotification($notification->getId()->toRfc4122()));
        }
        $this->entityManager->flush();
    }

    /**
     * One notification for many: the newest message's says how many need the user, the others are dropped.
     *
     * @param non-empty-list<array{MailNotification, Message}> $planned
     *
     * @return array{MailNotification, Message}
     */
    private function summary(array $planned, bool $previews, \DateTimeImmutable $now): array
    {
        usort($planned, static fn (array $a, array $b): int => $b[1]->getReceivedAt() <=> $a[1]->getReceivedAt());
        [$summary] = $planned[0];
        [$title, $body] = self::summaryText(array_map(static fn (array $pair): Message => $pair[1], $planned), $previews);
        $summary->summarize($title);
        $this->fields->sealNotificationBody($summary, $body);
        foreach (\array_slice($planned, 1) as [$notification]) {
            $notification->foldInto($summary, $now);
        }

        return $planned[0];
    }

    /**
     * The messages a summary stands for that still need the user, at delivery: its own and those folded into it.
     * Reading the newest one does not settle the others.
     *
     * @return list<Message>
     */
    private function stillNeeded(MailNotification $summary): array
    {
        /** @var list<MailNotification> $folded */
        $folded = $this->entityManager->getRepository(MailNotification::class)->findBy(['summarizedBy' => $summary]);
        $messages = array_filter([$summary->getMessage(), ...array_map(static fn (MailNotification $n): ?Message => $n->getMessage(), $folded)]);

        return array_values(array_filter($messages, fn (Message $message): bool => $this->needsTheUser($message)));
    }

    /**
     * "5 new messages to do", and who from when previews are on.
     *
     * @param non-empty-list<Message> $messages newest first
     *
     * @return array{string, string}
     */
    private static function summaryText(array $messages, bool $previews): array
    {
        $verdicts = array_values(array_unique(array_map(static fn (Message $message): string => (string) $message->getVerdict()?->value, $messages)));
        $what = match ($verdicts) {
            [Verdict::Do->value] => 'to do',
            [Verdict::Delegate->value] => 'to hand over',
            default => 'that need you',
        };
        $body = '';
        if ($previews) {
            $senders = array_values(array_unique(array_map(self::title(...), $messages)));
            $named = \array_slice($senders, 0, 2);
            $others = \count($senders) - \count($named);
            $body = 'From '.implode(', ', $named).($others > 0 ? \sprintf(' and %d other%s', $others, 1 === $others ? '' : 's') : '');
        }
        $count = \count($messages);

        return [1 === $count ? \sprintf('1 new message %s', $what) : \sprintf('%d new messages %s', $count, $what), $body];
    }

    /**
     * Whether a message needs the user now: judged `do` or `delegate`, unread, in an inbox, not waiting for a batch
     * (held mail notifies when its batch delivers it, see {@see released()}), and not in a conversation the user placed
     * themselves elsewhere (their placement wins over the message's own verdict). Checked when a notification is
     * planned and again when it is delivered.
     */
    private function needsTheUser(Message $message): bool
    {
        if ($message->isSeen() || $message->isHeld() || !self::isDoOrDelegate($message->getVerdict())) {
            return false;
        }
        $thread = $message->getThread();
        if ($thread->isClassifiedByUser() && !self::isDoOrDelegate($thread->getVerdict())) {
            return false;
        }

        return false !== $this->entityManager->getConnection()->fetchOne(
            "SELECT 1 FROM message_location l JOIN folder f ON f.id = l.folder_id WHERE l.message_id = :id AND f.role = 'inbox'",
            ['id' => $message->getId()->toRfc4122()],
        );
    }

    #[AsMessageHandler]
    public function onSend(SendMailNotification $message): void
    {
        $this->deliver($message->notificationId, new \DateTimeImmutable());
    }

    #[AsMessageHandler]
    public function onSweep(SweepMailNotifications $message): void
    {
        $this->sweep(new \DateTimeImmutable());
    }

    public function deliver(string $notificationId, \DateTimeImmutable $now): void
    {
        if (!Uuid::isValid($notificationId)) {
            return;
        }
        /** @var array{?MailNotification, list<array{string, ?NotificationDevice, ?string}>, ?\DateTimeImmutable} $next */
        $next = $this->entityManager->wrapInTransaction(function () use ($notificationId, $now): array {
            [$deliver, $retry, $waitUntil] = $this->prepare(Uuid::fromString($notificationId), $now);
            // Claimed in the transaction that marks it delivered: a crash before the sends leaves claimed rows, which
            // the sweep tries again, never a delivered notification nobody sends.
            $claimed = null === $deliver ? [] : $this->dispatcher->claim($deliver->getUser(), self::deliveryKey($deliver), NotificationChannelChoice::fromValues($deliver->getChannels()), !$retry);
            if (null !== $waitUntil) {
                $this->afterCommit->dispatch(new SendMailNotification($notificationId), [new DelayStamp(max(0, ($waitUntil->getTimestamp() - $now->getTimestamp()) * 1000))]);
            }

            return [$deliver, $claimed, $waitUntil];
        });
        [$deliver, $claimed] = $next;
        if (null !== $deliver && [] !== $claimed) {
            $this->dispatcher->deliver($claimed, $this->pushMessage($deliver, $now), self::deliveryKey($deliver), $now);
        }
        $this->entityManager->clear();
    }

    /**
     * Delivers due notifications whose message got lost, and sends failed or stuck deliveries again. Each on its own:
     * one that fails is logged and waits FIRE_BACKOFF, the others go on.
     */
    public function sweep(\DateTimeImmutable $now): void
    {
        $connection = $this->entityManager->getConnection();
        $latest = $now->modify('-'.self::MAX_LATE)->format('Y-m-d H:i:s');
        /** @var list<string> $due */
        $due = $connection->fetchFirstColumn(
            'SELECT id FROM mail_notification WHERE delivered_at IS NULL AND dropped_at IS NULL AND fire_at <= :now ORDER BY fire_at LIMIT :limit',
            ['now' => $now->format('Y-m-d H:i:s'), 'limit' => self::SWEEP_BATCH],
        );
        /** @var list<string> $retry */
        $retry = $connection->fetchFirstColumn(
            "SELECT DISTINCT n.id FROM mail_notification n
             JOIN notification_delivery d ON d.delivery_key = 'mail:' || n.id
             WHERE n.delivered_at > :latest
               AND ((d.status = :failed AND d.attempts < :max AND d.updated_at <= CAST(:now AS TIMESTAMP) - INTERVAL '1 minute' * POWER(2, d.attempts - 1))
                 OR (d.status = :sending AND d.updated_at <= CAST(:now AS TIMESTAMP) - CAST(:stuck AS INTERVAL)))
             LIMIT :limit",
            [
                'now' => $now->format('Y-m-d H:i:s'), 'latest' => $latest, 'limit' => self::SWEEP_BATCH,
                'failed' => NotificationDelivery::FAILED, 'sending' => NotificationDelivery::SENDING, 'max' => NotificationDispatcher::MAX_ATTEMPTS, 'stuck' => NotificationDispatcher::STUCK,
            ],
        );
        foreach (array_unique([...$due, ...$retry]) as $id) {
            try {
                $this->deliver($id, $now);
            } catch (\Throwable $e) {
                $this->logger->error('Delivering a mail notification failed', ['notification' => $id, 'error' => $e->getMessage()]);
                $this->managers->resetManager();
                $this->entityManager->getConnection()->executeStatement(
                    'UPDATE mail_notification SET fire_at = :later WHERE id = :id AND delivered_at IS NULL AND dropped_at IS NULL',
                    ['id' => $id, 'later' => $now->modify(self::FIRE_BACKOFF)->format('Y-m-d H:i:s')],
                );
            }
        }
    }

    public static function deliveryKey(MailNotification $notification): string
    {
        return 'mail:'.$notification->getId()->toRfc4122();
    }

    /**
     * What to do now: the notification to send (marked delivered), and whether that is a retry of an earlier delivery;
     * or the time it now waits until (a focus block or meeting); or nothing.
     *
     * @return array{?MailNotification, bool, ?\DateTimeImmutable}
     */
    private function prepare(Uuid $id, \DateTimeImmutable $now): array
    {
        $notification = $this->entityManager->find(MailNotification::class, $id, LockMode::PESSIMISTIC_WRITE);
        if (null === $notification || null !== $notification->getDroppedAt()) {
            return [null, false, null];
        }
        if ($notification->isDelivered()) {
            // Send again what failed or got stuck; the dispatcher leaves what went out alone.
            return [$notification->getDeliveredAt() > $now->modify('-'.self::MAX_LATE) ? $notification : null, true, null];
        }
        if ($notification->getFireAt()->getTimestamp() > $now->getTimestamp() + self::EARLY_SECONDS) {
            return [null, false, null];
        }
        $message = $notification->getMessage();
        $needed = $notification->isSummary() ? $this->stillNeeded($notification) : (null !== $message && $this->needsTheUser($message) ? [$message] : []);
        if ([] === $needed || $notification->getFireAt() < $now->modify('-'.self::MAX_LATE)) {
            // Read, archived or judged otherwise meanwhile, or too late after an outage: no news any more.
            return $this->drop($notification, $now);
        }

        $user = $notification->getUser();
        $preferences = $this->preferences->forUser($user);
        if ($notification->isSummary() && 1 === \count($needed)) {
            // Only one still needs the user: it says what that one says and opens its conversation.
            [$only] = $needed;
            $previews = $preferences->isMailPreviews();
            $notification->narrowTo($only->getThread(), $previews ? self::title($only) : self::withoutContent($only));
            $this->fields->sealNotificationBody($notification, $previews ? $this->body($only) : '');
        } elseif ($notification->isSummary()) {
            // Says how many still need the user now; previews as they are set now.
            usort($needed, static fn (Message $a, Message $b): int => $b->getReceivedAt() <=> $a->getReceivedAt());
            [$title, $body] = self::summaryText($needed, $preferences->isMailPreviews());
            $notification->summarize($title);
            $this->fields->sealNotificationBody($notification, $body);
        }
        $channels = $preferences->channelsFor(NotificationKind::Mail->value, NotificationKind::Mail->defaultChannels());
        if ($channels->isEmpty()) {
            return $this->drop($notification, $now);
        }
        $holdUntil = null;
        if ($preferences->isHoldDuringFocus()) {
            $holdUntil = $this->presence->focusBlockEnd($user, $now);
        }
        if (null === $holdUntil && $preferences->isHoldMailInMeetings()) {
            $holdUntil = $this->presence->meetingEnd($user, $now);
        }
        if (null !== $holdUntil && $holdUntil > $now) {
            $notification->postpone($holdUntil);
            $this->entityManager->flush();

            return [null, false, $holdUntil];
        }
        $silent = null !== QuietHours::endOf($preferences, $now)
            || ($preferences->isFocusDuringBusy() && $this->presence->inBusyEvent($user, $now));

        // Turned off since it was planned.
        if (!$preferences->isMailPreviews()) {
            $notification->hideContent(self::withoutContent($needed[0]));
        }
        $notification->markDelivered($now, $channels->values(), $silent);
        $this->entityManager->flush();

        return [$notification, false, null];
    }

    /**
     * @return array{null, false, null}
     */
    private function drop(MailNotification $notification, \DateTimeImmutable $now): array
    {
        $notification->drop($now);
        $this->entityManager->flush();

        return [null, false, null];
    }

    /** Mail with this Message-ID and sender notified the user lately: the same mail reaching another of their accounts. */
    private function notifiedRecently(User $user, string $header, string $from, \DateTimeImmutable $now): bool
    {
        return false !== $this->entityManager->getConnection()->fetchOne(
            'SELECT 1 FROM mail_notification n JOIN message m ON m.id = n.message_id
             WHERE n.user_id = :user AND m.message_id_header = :header AND m.from_address = :from AND n.created_at > :since',
            ['user' => $user->getId()->toRfc4122(), 'header' => $header, 'from' => $from, 'since' => $now->modify('-'.self::FRESH)->format('Y-m-d H:i:s')],
        );
    }

    private function pushMessage(MailNotification $notification, \DateTimeImmutable $now): PushMessage
    {
        $threadId = $notification->getThread()?->getId()->toRfc4122();
        $data = array_filter(['threadId' => $threadId, 'messageId' => $notification->getMessage()?->getId()->toRfc4122()], static fn (?string $value): bool => null !== $value);

        return new PushMessage(
            $notification->getId()->toRfc4122(),
            NotificationKind::Mail->value,
            $notification->getTitle(),
            $this->fields->notificationBody($notification),
            null !== $threadId ? '/thread/'.$threadId : ($notification->isSummary() ? self::BATCHES_PATH : null),
            $notification->isSilent(),
            $now->modify(self::EXPIRES),
            $data,
            PushMessage::MAIL,
        );
    }

    private static function isDoOrDelegate(?Verdict $verdict): bool
    {
        return Verdict::Do === $verdict || Verdict::Delegate === $verdict;
    }

    /** What a notification says without previews: only the account the mail came to, as the user named it. */
    private static function withoutContent(Message $message): string
    {
        $account = $message->getMailAccount();
        $name = trim($account->getDisplayName());

        return 'New mail from '.('' === $name ? $account->getEmailAddress() : $name);
    }

    /** Who it is from: their name, else their address. */
    private static function title(Message $message): string
    {
        $name = trim($message->getFromName() ?? '');

        return '' === $name ? $message->getFromAddress() : $name;
    }

    /** The subject (marked when it is to hand over), and the start of the text on the next line. */
    private function body(Message $message): string
    {
        $subject = '' === trim($message->getSubject()) ? '(no subject)' : $message->getSubject();
        $line = Verdict::Delegate === $message->getVerdict() ? 'To hand over: '.$subject : $subject;
        $snippet = trim($this->fields->snippet($message));

        return '' === $snippet ? $line : $line."\n".mb_substr($snippet, 0, 200);
    }
}
