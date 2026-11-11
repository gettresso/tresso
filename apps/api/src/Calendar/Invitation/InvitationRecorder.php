<?php

declare(strict_types=1);

namespace App\Calendar\Invitation;

use App\ApiResource\Input\Sync\CalendarPartInput;
use App\Calendar\ICalendar\CalendarDocument;
use App\Calendar\ICalendar\Props;
use App\Entity\CalendarInvitation;
use App\Entity\Message;
use App\Enum\FolderRole;
use App\Enum\ItipMethod;
use App\Realtime\AfterCommitDispatcher;
use App\Repository\CalendarInvitationRepository;
use Doctrine\ORM\EntityManagerInterface;
use Psr\Log\LoggerInterface;
use Sabre\VObject\Component\VCalendar;

/**
 * Records the calendar objects that came with a new message, at ingest, and has them applied to the user's calendars
 * once the ingest is committed (when $apply says the message may change the calendar). Parts that are not usable iTIP (no METHOD, no event, broken) are skipped: a message
 * must never fail to ingest because of its calendar part.
 */
final readonly class InvitationRecorder
{
    public function __construct(
        private EntityManagerInterface $entityManager,
        private AfterCommitDispatcher $afterCommit,
        private CalendarInvitationRepository $invitations,
        private LoggerInterface $logger,
    ) {
    }

    /**
     * The message arrived in a folder (new, or a copy moved there). Calendar mail in Spam or Trash is not looked at.
     * It changes the calendar only from the inbox and only when it arrived after the account was connected: the
     * first sync of years of mail must not replay old invitations and cancellations. The rest is kept, so the message
     * still shows what it carries and the user can apply it. Mail recorded before and moved into the inbox later (or
     * rescued from Spam) is applied then.
     *
     * @param list<CalendarPartInput> $parts
     */
    public function arrived(Message $message, FolderRole $role, array $parts): void
    {
        if (\in_array($role, [FolderRole::Spam, FolderRole::Trash], true)) {
            return;
        }
        $apply = FolderRole::Inbox === $role && $message->getReceivedAt() >= $message->getMailAccount()->getCreatedAt();
        $recorded = $this->invitations->findForMessage($message);
        if ([] === $recorded) {
            foreach ($parts as $part) {
                $this->record($message, $part->method, $part->ical, $apply);
            }

            return;
        }
        foreach ($recorded as $invitation) {
            if ($apply && null === $invitation->getAppliedAt()) {
                $this->afterCommit->dispatch(new ApplyCalendarInvitation($invitation->getId()->toRfc4122()));
            }
        }
    }

    public function record(Message $message, ?string $partMethod, string $ical, bool $apply): ?CalendarInvitation
    {
        try {
            $calendar = CalendarDocument::parse($ical);
            $read = self::read($calendar, $partMethod);
        } catch (\Throwable $e) {
            // sabre reads most values lazily, so a malformed date or rule only fails here; whatever it is, the
            // message is stored without its calendar part.
            $this->logger->info('Skipping an unreadable calendar part', ['message' => $message->getId()->toRfc4122(), 'error' => $e::class.': '.$e->getMessage()]);

            return null;
        }
        if (null === $read) {
            return null;
        }

        [$method, $uid, $sequence, $recurrenceKey, $serialized] = $read;
        $invitation = new CalendarInvitation($message, $method, $uid, $sequence, $recurrenceKey, $serialized);
        $this->entityManager->persist($invitation);
        if ($apply) {
            $this->afterCommit->dispatch(new ApplyCalendarInvitation($invitation->getId()->toRfc4122()));
        }

        return $invitation;
    }

    /**
     * What an invitation row stores of a calendar part, or null when the part is not usable iTIP or does not fit
     * the columns (a UID longer than any calendar writes).
     *
     * @return array{ItipMethod, string, int, string, string}|null
     */
    private static function read(VCalendar $calendar, ?string $partMethod): ?array
    {
        // The Content-Type parameter comes from the sender as is: anything that is not an iTIP method is ignored.
        $method = ItipMethod::tryFrom(strtoupper(Props::text($calendar, 'METHOD') ?? trim((string) $partMethod)));
        $groups = CalendarDocument::eventsByUid($calendar);
        if (null === $method || 1 !== \count($groups)) {
            return null;
        }
        $uid = (string) array_key_first($groups);
        if (mb_strlen($uid) > Props::MAX_UID_LENGTH) {
            return null;
        }
        $sequence = 0;
        $recurrenceKey = '';
        $hasMaster = false;
        foreach ($groups[$uid] as $event) {
            $sequence = max($sequence, Props::sequence($event));
            $key = CalendarDocument::recurrenceKey($event);
            if ('' === $key) {
                $hasMaster = true;
                continue;
            }
            $recurrenceKey = '' === $recurrenceKey ? $key : $recurrenceKey;
        }

        return [$method, $uid, $sequence, $hasMaster ? '' : $recurrenceKey, $calendar->serialize()];
    }
}
