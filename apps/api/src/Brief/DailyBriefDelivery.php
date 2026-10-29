<?php

declare(strict_types=1);

namespace App\Brief;

use App\Billing\Entitlements;
use App\Entity\DailyBrief;
use App\Entity\NotificationPreferences;
use App\Enum\NotificationChannel;
use App\Mail\MessageFields;
use App\Notification\Channel\EmailNotifier;
use App\Notification\Channel\PushMessage;
use App\Notification\NotificationChannelChoice;
use App\Notification\NotificationDispatcher;
use App\Notification\QuietHours;
use App\Repository\DailyBriefRepository;
use App\Repository\NotificationPreferencesRepository;
use Doctrine\DBAL\Connection;
use Doctrine\DBAL\LockMode;
use Doctrine\ORM\EntityManagerInterface;
use Symfony\Bridge\Twig\Mime\TemplatedEmail;
use Symfony\Component\DependencyInjection\Attribute\Autowire;
use Symfony\Component\Mailer\MailerInterface;
use Symfony\Component\Uid\Uuid;

/**
 * Sends a daily brief besides the app, on the channels of the user's notification preferences for kind
 * `daily_brief` (none unless they chose some): a push to their phones and desktops through the
 * {@see NotificationDispatcher}, silent during quiet hours, and by email a digest of the conversations per smart
 * inbox from the system sender to their notification address. Noting happens in the app.
 */
final readonly class DailyBriefDelivery
{
    /** The kind of notification the brief is; its channels are chosen in the notification preferences. */
    public const string KIND = 'daily_brief';

    /** Push services drop the brief when it could not be delivered by then: the next one is on its way. */
    private const string EXPIRES = '+12 hours';

    /** Subjects the push names before "and N more". */
    private const int PUSH_SUBJECTS = 3;

    public function __construct(
        private EntityManagerInterface $entityManager,
        private Connection $connection,
        private DailyBriefRepository $briefs,
        private NotificationPreferencesRepository $preferences,
        private NotificationDispatcher $dispatcher,
        private EmailNotifier $email,
        private MailerInterface $mailer,
        #[Autowire(env: 'WEB_APP_URL')]
        private string $webAppUrl,
        private MessageFields $fields,
        private Entitlements $entitlements,
    ) {
    }

    private static function text(mixed $value): string
    {
        return \is_string($value) ? $value : throw new \UnexpectedValueException('Expected a text column.');
    }

    /** Where a brief goes besides the app unless the user chose otherwise: nowhere. */
    public static function defaultChannels(): NotificationChannelChoice
    {
        return new NotificationChannelChoice();
    }

    public static function channelsFor(NotificationPreferences $preferences): NotificationChannelChoice
    {
        return $preferences->channelsFor(self::KIND, self::defaultChannels());
    }

    /**
     * Sends the brief on the channels chosen now. Every channel goes out once: the dispatcher keeps a delivery per
     * device, the digest its send time on the brief. A brief that is gone, or whose conversations all are, sends
     * nothing. A failed email is raised, so Messenger retries; the pushes sent before are not sent again.
     */
    public function deliver(string $briefId, \DateTimeImmutable $now): void
    {
        $brief = $this->briefs->findOneById($briefId);
        if (null === $brief) {
            return;
        }
        $user = $brief->getOwner();
        if (!$this->entitlements->allows($user->getId())) {
            return;
        }
        $preferences = $this->preferences->forUser($user);
        $choice = self::channelsFor($preferences);
        $sections = $this->sections($brief);
        if ($choice->isEmpty() || [] === $sections) {
            return;
        }

        $push = new NotificationChannelChoice(...array_values(array_filter($choice->channels, static fn (NotificationChannel $channel): bool => NotificationChannel::Email !== $channel)));
        $this->dispatcher->send($user, $this->pushMessage($brief, $sections, $preferences, $now), self::KIND.':'.$brief->getId()->toRfc4122(), $push, $now);

        if ($choice->includes(NotificationChannel::Email)) {
            $this->sendDigest($brief->getId()->toRfc4122(), $preferences, $sections, $now);
        }
    }

    /**
     * @param list<array{name: string, entries: list<array<string, mixed>>}> $sections
     */
    private function pushMessage(DailyBrief $brief, array $sections, NotificationPreferences $preferences, \DateTimeImmutable $now): PushMessage
    {
        $subjects = [];
        foreach ($sections as $section) {
            foreach ($section['entries'] as $entry) {
                $subjects[] = \is_string($entry['subject']) && '' !== $entry['subject'] ? $entry['subject'] : '(no subject)';
            }
        }
        $count = \count($subjects);
        $shown = \array_slice($subjects, 0, self::PUSH_SUBJECTS);
        $body = implode("\n", $shown).($count > self::PUSH_SUBJECTS ? \sprintf("\nand %d more", $count - self::PUSH_SUBJECTS) : '');

        return new PushMessage(
            $brief->getId()->toRfc4122(),
            self::KIND,
            \sprintf('Daily brief: %d to know', $count),
            $body,
            '/brief',
            null !== QuietHours::endOf($preferences, $now),
            $now->modify(self::EXPIRES),
            androidChannel: PushMessage::MAIL,
        );
    }

    /**
     * Sends the digest at most once: the send is recorded first, in its own short transaction under a row lock, so a
     * retry or a second worker finds it taken; the mail goes out after that commit, never inside a transaction. When
     * the mail server refuses it the record is taken back, so Messenger's retry sends it. A crash between the two
     * loses this digest rather than sending it twice; the brief itself is in the app either way.
     *
     * @param list<array{name: string, entries: list<array<string, mixed>>}> $sections
     */
    private function sendDigest(string $briefId, NotificationPreferences $preferences, array $sections, \DateTimeImmutable $now): void
    {
        $claimed = $this->entityManager->wrapInTransaction(function () use ($briefId, $now): ?DailyBrief {
            $brief = $this->briefs->findOneById($briefId);
            if (null === $brief) {
                return null;
            }
            $this->entityManager->refresh($brief, LockMode::PESSIMISTIC_WRITE);
            if (null !== $brief->getEmailedAt()) {
                return null;
            }
            $brief->emailed($now);
            $this->entityManager->flush();

            return $brief;
        });
        if (null === $claimed) {
            return;
        }

        try {
            $this->mailer->send($this->digest($claimed, $preferences, $sections));
        } catch (\Throwable $error) {
            $this->entityManager->wrapInTransaction(function () use ($briefId): void {
                $this->entityManager->getConnection()->executeStatement('UPDATE daily_brief SET emailed_at = NULL WHERE id = :id', ['id' => $briefId]);
            });
            throw $error;
        }
    }

    /**
     * @param list<array{name: string, entries: list<array<string, mixed>>}> $sections
     */
    private function digest(DailyBrief $brief, NotificationPreferences $preferences, array $sections): TemplatedEmail
    {
        $zone = new \DateTimeZone($preferences->getTimeZone());
        $madeAt = $brief->getCreatedAt()->setTimezone($zone);
        $count = array_sum(array_map(static fn (array $section): int => \count($section['entries']), $sections));
        $web = rtrim($this->webAppUrl, '/');

        $email = new TemplatedEmail()
            ->from($this->email->sender())
            ->to($this->dispatcher->emailAddressFor($brief->getOwner()))
            ->subject(\sprintf('Your daily brief: %d to know', $count))
            ->htmlTemplate('emails/daily_brief.html.twig')
            ->textTemplate('emails/daily_brief.txt.twig')
            ->context([
                'date' => $madeAt->format('l j F'),
                'time' => $madeAt->format('H:i'),
                'count' => $count,
                'sections' => $sections,
                'briefUrl' => $web.'/brief/'.$brief->getId()->toRfc4122(),
                'settingsUrl' => $web.'/settings/brief',
                'webUrl' => $web,
                'zone' => $zone,
            ]);
        // Mail servers and the user's own rules should treat it as automated, and never answer it.
        $email->getHeaders()->addTextHeader('Auto-Submitted', 'auto-generated');

        return $email;
    }

    /**
     * The brief's conversations that still exist, per smart inbox in sidebar order, newest first within each.
     *
     * @return list<array{name: string, entries: list<array<string, mixed>>}>
     */
    private function sections(DailyBrief $brief): array
    {
        if ([] === $brief->getThreadIds()) {
            return [];
        }
        $rows = $this->connection->fetchAllAssociative(
            "SELECT t.id, t.subject, COALESCE(c.name, 'Other') AS smart_inbox, c.position, a.email_address AS account,
                    n.message_id, n.from_address, n.from_name, n.snippet, n.sealed_snippet, n.received_at
             FROM thread t
             JOIN mail_account a ON a.id = t.mail_account_id
             LEFT JOIN category c ON c.id = t.category_id
             JOIN LATERAL (
                 SELECT m.id AS message_id, m.from_address, m.from_name, m.snippet, m.sealed_snippet, m.received_at FROM message m
                 WHERE m.thread_id = t.id ORDER BY m.received_at DESC, m.id DESC LIMIT 1
             ) n ON true
             WHERE a.owner_id = :owner AND t.id = ANY(CAST(:threads AS UUID[]))
             ORDER BY c.position NULLS LAST, smart_inbox, n.received_at DESC, t.id DESC",
            [
                'owner' => $brief->getOwner()->getId()->toRfc4122(),
                'threads' => '{'.implode(',', $brief->getThreadIds()).'}',
            ],
        );

        $owner = $brief->getOwner()->getId();
        $sections = [];
        foreach ($rows as $row) {
            $name = \is_string($row['smart_inbox']) ? $row['smart_inbox'] : throw new \UnexpectedValueException('Expected a smart inbox name.');
            $sections[$name] ??= ['name' => $name, 'entries' => []];
            $sections[$name]['entries'][] = [
                'threadId' => $row['id'],
                'subject' => $row['subject'],
                'from' => \is_string($row['from_name']) && '' !== trim($row['from_name']) ? $row['from_name'] : $row['from_address'],
                'account' => $row['account'],
                'snippet' => $this->fields->snippetOf($owner, Uuid::fromString(self::text($row['message_id'])), null === $row['sealed_snippet'] ? null : self::text($row['sealed_snippet']), self::text($row['snippet'])),
                'receivedAt' => \is_string($row['received_at']) ? new \DateTimeImmutable($row['received_at'], new \DateTimeZone('UTC')) : null,
            ];
        }

        return array_values($sections);
    }
}
