<?php

declare(strict_types=1);

namespace App\Calendar\Invitation;

use App\Calendar\CalendarStore;
use App\Calendar\ICalendar\CalendarDocument;
use App\Calendar\ICalendar\InvalidCalendarData;
use App\Calendar\ICalendar\Occurrences;
use App\Calendar\ICalendar\Props;
use App\Calendar\LocalCalendars;
use App\Calendar\SelfAddresses;
use App\Classification\ReceivingServers;
use App\Classification\SenderAuthentication;
use App\Entity\Calendar;
use App\Entity\CalendarInvitation;
use App\Entity\CalendarObject;
use App\Entity\MailAccount;
use App\Entity\MessageSignals;
use App\Entity\User;
use App\Enum\ItipMethod;
use App\Repository\CalendarObjectRepository;
use App\Repository\CalendarRepository;
use Doctrine\DBAL\LockMode;
use Doctrine\ORM\EntityManagerInterface;
use Psr\Log\LoggerInterface;
use Sabre\VObject\Component\VCalendar;
use Sabre\VObject\Component\VEvent;
use Sabre\VObject\InvalidDataException;
use Sabre\VObject\ITip\Broker;
use Sabre\VObject\ITip\Message as ItipMessage;
use Symfony\Component\Messenger\Attribute\AsMessageHandler;
use Symfony\Component\Uid\Uuid;

/**
 * Applies calendar mail to the user's calendars (RFC 5546 from the receiving side):
 *
 * - REQUEST: a new or updated invitation for the user lands in the account's default calendar (or the Tresso
 *   calendar), unanswered. Updates older than what is stored are ignored.
 * - CANCEL: the event, or the cancelled occurrences, become cancelled.
 * - REPLY: an attendee's answer to an event the user organizes.
 *
 * Anyone can send calendar mail, so a message only counts when it comes from the right person: a REQUEST or CANCEL
 * from the event's organizer (as stored, or as the message says for an event that is new), or from a delegate the
 * stored event already names (SENT-BY; one named only in the message itself proves nothing), and a REPLY from an
 * attendee the event already has. A message never changes an event the user organizes, never changes who organizes
 * an event, and never raises SEQUENCE by more than MAX_SEQUENCE_STEP at once, so a forged high SEQUENCE cannot lock
 * out the organizer's later updates. Versions follow RFC 5546: a higher SEQUENCE wins, at the same SEQUENCE a later
 * DTSTAMP; an update at the same SEQUENCE keeps the user's answer. Every change locks the stored object, as edits do.
 *
 * Calendars whose provider schedules by itself (CalDAV auto-schedule, Google, Microsoft) get invitations from the
 * provider; Tresso never writes those events, so the same event is not there twice.
 */
#[AsMessageHandler]
final readonly class InvitationApplier
{
    public const int MAX_SEQUENCE_STEP = 100;

    public function __construct(
        private EntityManagerInterface $entityManager,
        private CalendarObjectRepository $objects,
        private CalendarRepository $calendars,
        private LocalCalendars $localCalendars,
        private CalendarStore $store,
        private SelfAddresses $selfAddresses,
        private LoggerInterface $logger,
    ) {
    }

    public function __invoke(ApplyCalendarInvitation $command): void
    {
        $this->entityManager->wrapInTransaction(function () use ($command): void {
            // Locked, so the worker and the user's apply action never both apply it.
            $invitation = Uuid::isValid($command->invitationId) ? $this->entityManager->find(CalendarInvitation::class, Uuid::fromString($command->invitationId), LockMode::PESSIMISTIC_WRITE) : null;
            if (null === $invitation || null !== $invitation->getAppliedAt()) {
                return;
            }
            if ($this->senderUnconfirmed($invitation)) {
                // Left for the user, who sees why on the message and can apply it by hand.
                $this->logger->info('Calendar mail from a sender the provider did not confirm is not applied by itself', ['invitation' => $invitation->getId()->toRfc4122()]);

                return;
            }
            $this->applyNow($invitation);
        });
        $this->entityManager->clear();
    }

    /**
     * Whether calendar mail that would change what the calendar has (an update, a cancellation or a reply) comes from a
     * sender the receiving provider did not confirm: on Gmail and Microsoft accounts, whose topmost
     * Authentication-Results header is the provider's own ({@see ReceivingServers}), DMARC must pass for the From
     * domain, or anyone who knows an event's UID could move or cancel it with a forged From. A new invitation changes
     * nothing that is there and stays automatic. On other (IMAP) accounts nothing can be verified, so nothing is held.
     */
    public function senderUnconfirmed(CalendarInvitation $invitation): bool
    {
        $message = $invitation->getMessage();
        $account = $message->getMailAccount();
        if (!ReceivingServers::trustsTopmostHeader($account)) {
            return false;
        }
        $changesExisting = match ($invitation->getMethod()) {
            ItipMethod::Cancel, ItipMethod::Reply => true,
            ItipMethod::Request => [] !== $this->objects->findForOwnerByUid($account->getOwner(), $invitation->getUid()),
            default => false,
        };
        if (!$changesExisting) {
            return false;
        }
        $headers = $this->entityManager->find(MessageSignals::class, $message->getId())?->getHeaders() ?? [];

        return !SenderAuthentication::dmarcPassed($headers['authentication-results'] ?? null, true);
    }

    /**
     * Applies calendar mail now, in the caller's transaction (which holds a lock on the invitation), with every check.
     * It is marked applied whatever the checks decided, so it is never applied twice; unless there was no calendar
     * to write to, so it can be applied once there is one.
     */
    public function applyNow(CalendarInvitation $invitation): InvitationOutcome
    {
        try {
            $outcome = $this->apply($invitation);
        } catch (InvalidCalendarData|InvalidDataException $e) {
            // sabre reads values lazily, so a malformed one can fail anywhere in the checks: never retried forever.
            $outcome = InvitationOutcome::ignored('The calendar part of the message cannot be read: '.$e->getMessage());
        }
        if (InvitationOutcome::APPLIED !== $outcome->status) {
            $this->logger->info('Calendar mail not applied', ['invitation' => $invitation->getId()->toRfc4122(), 'status' => $outcome->status, 'reason' => $outcome->reason]);
        }
        if (InvitationOutcome::NO_TARGET !== $outcome->status) {
            $invitation->markApplied(new \DateTimeImmutable());
        }
        $this->entityManager->flush();

        return $outcome;
    }

    /**
     * Why the calendar mail cannot be applied now (the calendar it would change is read-only or scheduled by its
     * provider), or null when it can. Nothing is created or changed; clients show the apply action only without one.
     */
    public function blocker(CalendarInvitation $invitation): ?string
    {
        $account = $invitation->getMessage()->getMailAccount();
        $object = self::pick($this->objects->findForOwnerByUid($account->getOwner(), $invitation->getUid()), $account);
        if (null !== $object) {
            return self::blockedBy($object->getCalendar());
        }
        $default = $this->calendars->findDefaultFor($account);

        return ItipMethod::Request === $invitation->getMethod() && null !== $default ? self::blockedBy($default) : null;
    }

    /** Why calendar mail cannot change this calendar, or null when it can. */
    private static function blockedBy(Calendar $calendar): ?string
    {
        return match (true) {
            // The provider puts invitations into its calendar itself; Tresso would only duplicate them.
            $calendar->providerSchedules() => 'The provider of this calendar puts invitations into it itself.',
            !$calendar->isWritable() => \sprintf('The calendar "%s" is read-only, so it cannot take the change.', $calendar->getName()),
            default => null,
        };
    }

    /**
     * Of the user's objects with this UID, the one this mail is about: in a calendar of the account it came to, else
     * a Tresso calendar, else the first.
     *
     * @param list<CalendarObject> $objects
     */
    public static function pick(array $objects, MailAccount $account): ?CalendarObject
    {
        foreach ($objects as $object) {
            if ($object->getCalendar()->getMailAccount()?->getId()->equals($account->getId())) {
                return $object;
            }
        }
        foreach ($objects as $object) {
            if ($object->getCalendar()->isLocal()) {
                return $object;
            }
        }

        return $objects[0] ?? null;
    }

    private function apply(CalendarInvitation $invitation): InvitationOutcome
    {
        $account = $invitation->getMessage()->getMailAccount();
        $user = $account->getOwner();
        $self = $this->selfAddresses->of($user);
        $itip = CalendarDocument::forUid(CalendarDocument::parse($invitation->getIcal()), $invitation->getUid());

        $object = self::pick($this->objects->findForOwnerByUid($user, $invitation->getUid()), $account);
        $blocked = null === $object ? null : self::blockedBy($object->getCalendar());
        if (null !== $blocked) {
            return InvitationOutcome::noTarget($blocked);
        }
        if (null !== $object) {
            $object = $this->objects->lock($object);
        }
        $sender = mb_strtolower($invitation->getMessage()->getFromAddress());

        return match ($invitation->getMethod()) {
            ItipMethod::Request => $this->request($invitation, $itip, $object, $user, $self, $sender),
            ItipMethod::Cancel => $this->cancel($invitation, $itip, $object, $self, $sender),
            ItipMethod::Reply => $this->reply($itip, $object, $self, $sender, $invitation->getUid(), $invitation->getSequence()),
            default => InvitationOutcome::ignored('Only invitations, updates, cancellations and replies change the calendar.'),
        };
    }

    /**
     * Why a REQUEST or CANCEL may not change the stored event, or null when it may: it must come from the stored
     * organizer (or a delegate the stored event names), keep that organizer, be about an event the user does not
     * organize, and not jump SEQUENCE too far.
     *
     * @param list<string> $self
     */
    private static function untrusted(CalendarInvitation $invitation, VCalendar $itip, VCalendar $current, array $self, string $sender): ?string
    {
        $organizer = self::organizer($current);

        return match (true) {
            null === $organizer => 'The event in your calendar has no organizer, so it is your own.',
            \in_array($organizer, $self, true) => 'You organize this event.',
            !self::names($itip, $organizer) => 'It would change who organizes the event.',
            $sender !== $organizer && !self::delegates($current, $sender) => 'It does not come from the organizer of the event.',
            $invitation->getSequence() > self::sequenceOf(CalendarDocument::master($current) ?? CalendarDocument::events($current)[0] ?? null) + self::MAX_SEQUENCE_STEP => 'Its SEQUENCE jumps too far.',
            default => null,
        };
    }

    /**
     * @param list<string> $self
     */
    private function request(CalendarInvitation $invitation, VCalendar $itip, ?CalendarObject $object, User $user, array $self, string $sender): InvitationOutcome
    {
        if (!self::invites($itip, $self)) {
            return InvitationOutcome::ignored('The invitation is not for you.');
        }

        if (null === $object) {
            // A new event proves its organizer only by coming from them: a delegate named in the message itself
            // (SENT-BY) is the sender's own claim.
            $organizer = self::organizer($itip);
            if (null === $organizer || $sender !== $organizer) {
                return InvitationOutcome::ignored('It does not come from the organizer of the event.');
            }
            [$calendar, $reason] = $this->targetCalendar($invitation->getMessage()->getMailAccount(), $user);
            if (null === $calendar) {
                return InvitationOutcome::noTarget($reason ?? 'There is no calendar to put it in.');
            }
            $this->save(new CalendarObject($calendar, $invitation->getUid(), ''), $itip, $invitation);

            return InvitationOutcome::applied();
        }

        $current = CalendarDocument::parse($object->getIcal());
        $reason = self::untrusted($invitation, $itip, $current, $self, $sender);
        if (null !== $reason) {
            return InvitationOutcome::ignored($reason);
        }

        $itipMaster = CalendarDocument::master($itip);
        $currentMaster = CalendarDocument::master($current);
        if (null !== $itipMaster) {
            // The whole event: taken over when newer, keeping the user's answers where the organizer did not reset them.
            if (!self::newer($itipMaster, $currentMaster ?? CalendarDocument::events($current)[0] ?? null)) {
                return InvitationOutcome::ignored('Your calendar has this version of the event or a newer one.');
            }
            foreach (CalendarDocument::events($itip) as $event) {
                $key = CalendarDocument::recurrenceKey($event);
                // A new override keeps the answer the user gave the series.
                $old = '' === $key ? $currentMaster : CalendarDocument::override($current, $key) ?? $currentMaster;
                self::keepAnswers($event, $old, $self);
            }
            $this->save($object, $itip, $invitation);

            return InvitationOutcome::applied();
        }

        // Single occurrences (with or without the series stored): each one that is newer replaces its own, the others
        // stay.
        $changed = false;
        foreach (CalendarDocument::events($itip) as $override) {
            $key = CalendarDocument::recurrenceKey($override);
            if ('' === $key) {
                continue;
            }
            $old = CalendarDocument::override($current, $key);
            if (!self::newer($override, $old ?? $currentMaster)) {
                continue;
            }
            $new = clone $override;
            self::keepAnswers($new, $old ?? $currentMaster, $self);
            if (null !== $old) {
                $current->remove($old);
            }
            $current->add($new);
            $changed = true;
        }
        if (!$changed) {
            return InvitationOutcome::ignored('Your calendar has these occurrences in this version or a newer one.');
        }
        $this->save($object, $current, $invitation);

        return InvitationOutcome::applied();
    }

    /**
     * @param list<string> $self
     */
    private function cancel(CalendarInvitation $invitation, VCalendar $itip, ?CalendarObject $object, array $self, string $sender): InvitationOutcome
    {
        if (null === $object) {
            return InvitationOutcome::ignored('Your calendar does not have this event.');
        }
        $current = CalendarDocument::parse($object->getIcal());
        $reason = self::untrusted($invitation, $itip, $current, $self, $sender);
        if (null !== $reason) {
            return InvitationOutcome::ignored($reason);
        }

        $master = CalendarDocument::master($current);
        $cancelled = [];
        if (null !== CalendarDocument::master($itip) || '' === $invitation->getRecurrenceKey()) {
            // The whole event, measured against the series, not against a single changed occurrence.
            if ($invitation->getSequence() < self::sequenceOf($master ?? CalendarDocument::events($current)[0] ?? null)) {
                return InvitationOutcome::ignored('Your calendar has a newer version of the event.');
            }
            foreach (CalendarDocument::events($current) as $event) {
                $cancelled[] = [$event, $invitation->getSequence()];
            }
        } else {
            foreach (CalendarDocument::events($itip) as $event) {
                $key = CalendarDocument::recurrenceKey($event);
                $stored = CalendarDocument::override($current, $key);
                if (Props::int($event, 'SEQUENCE') < self::sequenceOf($stored ?? $master)) {
                    continue;
                }
                if (null === $stored && null !== $master) {
                    try {
                        $stored = Occurrences::override($current, $master, $key);
                    } catch (InvalidCalendarData) {
                        // Not an occurrence of the series as stored: the others still go.
                        continue;
                    }
                }
                if (null !== $stored) {
                    $cancelled[] = [$stored, Props::int($event, 'SEQUENCE')];
                }
            }
        }
        if ([] === $cancelled) {
            return InvitationOutcome::ignored('None of the cancelled occurrences is in your calendar in an older version.');
        }
        foreach ($cancelled as [$event, $sequence]) {
            Props::set($event, 'STATUS', 'CANCELLED');
            Props::set($event, 'SEQUENCE', $sequence);
        }
        $this->store->save($object, $current);

        return InvitationOutcome::applied();
    }

    /**
     * @param list<string> $self
     */
    private function reply(VCalendar $itip, ?CalendarObject $object, array $self, string $sender, string $uid, int $sequence): InvitationOutcome
    {
        if (null === $object) {
            return InvitationOutcome::ignored('Your calendar does not have this event.');
        }
        $current = CalendarDocument::parse($object->getIcal());
        $master = CalendarDocument::master($current) ?? CalendarDocument::events($current)[0] ?? null;
        $organizer = null === $master ? null : Props::get($master, 'ORGANIZER');
        if (null === $organizer || !\in_array(Props::address(Props::value($organizer)), $self, true)) {
            return InvitationOutcome::ignored('You do not organize this event.');
        }
        // The answer counts only from the attendee it is about, and only for someone the event already invites:
        // otherwise anyone could add themselves and receive every later update.
        $stored = self::storedAttendee($current, $sender);
        if (null === $stored) {
            return InvitationOutcome::ignored('The sender is not a guest of the event.');
        }
        // One spelling of the guest on every component, so sabre (which compares exactly) updates an occurrence that
        // spells them differently instead of adding them again.
        foreach (CalendarDocument::events($current) as $event) {
            foreach (Props::all($event, 'ATTENDEE') as $attendee) {
                if (Props::address(Props::value($attendee)) === $sender) {
                    $attendee->setValue($stored);
                }
            }
        }
        $answers = 0;
        foreach (CalendarDocument::events($itip) as $event) {
            foreach (Props::all($event, 'ATTENDEE') as $attendee) {
                if (Props::address(Props::value($attendee)) !== $sender) {
                    return InvitationOutcome::ignored('The reply speaks for someone other than its sender.');
                }
                if (null === Props::param($attendee, 'PARTSTAT')) {
                    return InvitationOutcome::ignored('The reply carries no answer.');
                }
                ++$answers;
            }
        }
        if (0 === $answers) {
            return InvitationOutcome::ignored('The reply carries no answer.');
        }

        $message = new ItipMessage();
        $message->method = 'REPLY';
        $message->component = 'VEVENT';
        $message->uid = $uid;
        $message->sequence = $sequence;
        // As the event spells the address, so sabre (which compares exactly) updates that guest, not adds another.
        $message->sender = $stored;
        $message->recipient = Props::value($organizer);
        $message->message = $itip;

        try {
            $updated = new Broker()->processMessage($message, $current);
        } catch (\Throwable $e) {
            // sabre fails on replies it cannot read; such mail is ignored, never retried forever.
            return InvitationOutcome::ignored('The reply cannot be read: '.$e->getMessage());
        }
        if (!$updated instanceof VCalendar) {
            return InvitationOutcome::ignored('The reply changes nothing.');
        }
        $this->store->save($object, $updated);

        return InvitationOutcome::applied();
    }

    private function save(CalendarObject $object, VCalendar $calendar, CalendarInvitation $invitation): void
    {
        foreach ($this->store->save($object, $calendar) as $row) {
            $row->setMessage($invitation->getMessage());
        }
        $this->entityManager->flush();
    }

    /**
     * The calendar a new invitation goes to, or null with the reason there is none.
     *
     * @return array{?Calendar, ?string}
     */
    private function targetCalendar(MailAccount $account, User $user): array
    {
        $default = $this->calendars->findDefaultFor($account);
        if (null === $default) {
            return [$this->localCalendars->ensure($user), null];
        }
        $blocked = self::blockedBy($default);

        return null === $blocked ? [$default, null] : [null, $blocked];
    }

    /**
     * RFC 5546 3.7: a higher SEQUENCE is newer; at the same SEQUENCE a later DTSTAMP is. Anything is newer than
     * nothing.
     */
    private static function newer(VEvent $incoming, ?VEvent $stored): bool
    {
        if (null === $stored) {
            return true;
        }
        $in = Props::int($incoming, 'SEQUENCE');
        $old = Props::int($stored, 'SEQUENCE');
        if ($in !== $old) {
            return $in > $old;
        }
        $inStamp = Props::dateTime($incoming, 'DTSTAMP')?->getDateTime();
        $oldStamp = Props::dateTime($stored, 'DTSTAMP')?->getDateTime();

        return null !== $inStamp && (null === $oldStamp || $inStamp > $oldStamp);
    }

    /**
     * An update at the same SEQUENCE is no change the user must answer again (RFC 5546 2.1.4): their answer stays.
     * A higher SEQUENCE is the organizer asking again, so theirs wins.
     *
     * @param list<string> $self
     */
    private static function keepAnswers(VEvent $incoming, ?VEvent $stored, array $self): void
    {
        if (null === $stored || Props::int($incoming, 'SEQUENCE') > Props::int($stored, 'SEQUENCE')) {
            return;
        }
        $answers = [];
        foreach (Props::all($stored, 'ATTENDEE') as $attendee) {
            $address = Props::address(Props::value($attendee));
            $partstat = Props::param($attendee, 'PARTSTAT');
            if (\in_array($address, $self, true) && null !== $partstat) {
                $answers[$address] = $partstat;
            }
        }
        foreach (Props::all($incoming, 'ATTENDEE') as $attendee) {
            $address = Props::address(Props::value($attendee));
            if (isset($answers[$address])) {
                $attendee['PARTSTAT'] = $answers[$address];
            }
        }
    }

    /**
     * The organizer's address, the same on every component, or null when there is none or they differ.
     */
    private static function organizer(VCalendar $calendar): ?string
    {
        $organizers = [];
        foreach (CalendarDocument::events($calendar) as $event) {
            $organizer = Props::get($event, 'ORGANIZER');
            $organizers[] = null === $organizer ? null : Props::address(Props::value($organizer));
        }
        $organizers = array_unique($organizers);

        return 1 === \count($organizers) ? $organizers[0] : null;
    }

    /** Whether every component of the message names this organizer. */
    private static function names(VCalendar $itip, string $organizer): bool
    {
        $events = CalendarDocument::events($itip);
        foreach ($events as $event) {
            $property = Props::get($event, 'ORGANIZER');
            if (null === $property || Props::address(Props::value($property)) !== $organizer) {
                return false;
            }
        }

        return [] !== $events;
    }

    /**
     * Whether the stored event names the sender as the organizer's delegate (SENT-BY on its ORGANIZER, as Outlook
     * writes it). A delegate named only in the incoming message proves nothing: anyone can write that.
     */
    private static function delegates(VCalendar $current, string $sender): bool
    {
        foreach (CalendarDocument::events($current) as $event) {
            $organizer = Props::get($event, 'ORGANIZER');
            $sentBy = null === $organizer ? null : Props::param($organizer, 'SENT-BY');
            if (null !== $sentBy && Props::address($sentBy) === $sender) {
                return true;
            }
        }

        return false;
    }

    /** The ATTENDEE value as the event spells it for this address, or null when it is no guest. */
    private static function storedAttendee(VCalendar $calendar, string $address): ?string
    {
        foreach (CalendarDocument::events($calendar) as $event) {
            foreach (Props::all($event, 'ATTENDEE') as $attendee) {
                if (Props::address(Props::value($attendee)) === $address) {
                    return Props::value($attendee);
                }
            }
        }

        return null;
    }

    /**
     * @param list<string> $self
     */
    private static function invites(VCalendar $itip, array $self): bool
    {
        foreach (CalendarDocument::events($itip) as $event) {
            $organizer = Props::get($event, 'ORGANIZER');
            if (null !== $organizer && \in_array(Props::address(Props::value($organizer)), $self, true)) {
                return false;
            }
            foreach (Props::all($event, 'ATTENDEE') as $attendee) {
                if (\in_array(Props::address(Props::value($attendee)), $self, true)) {
                    return true;
                }
            }
        }

        return false;
    }

    private static function sequenceOf(?VEvent $event): int
    {
        return null === $event ? 0 : Props::int($event, 'SEQUENCE');
    }
}
