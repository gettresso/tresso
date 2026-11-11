<?php

declare(strict_types=1);

namespace App\Calendar;

use App\Calendar\ICalendar\CalendarDocument;
use App\Calendar\ICalendar\ConferenceDetector;
use App\Calendar\ICalendar\EventReader;
use App\Calendar\ICalendar\EventTime;
use App\Calendar\ICalendar\InvalidCalendarData;
use App\Calendar\ICalendar\Occurrences;
use App\Calendar\ICalendar\Props;
use App\Calendar\ICalendar\RecurrenceKey;
use App\Calendar\ICalendar\VTimezoneBuilder;
use App\Calendar\Scheduling\ItipMailer;
use App\Calendar\Scheduling\SchedulingPermission;
use App\Entity\Calendar;
use App\Entity\CalendarEvent;
use App\Entity\CalendarObject;
use App\Entity\EventNote;
use App\Entity\MailAccount;
use App\Enum\CalendarSource;
use App\Enum\EditScope;
use App\Enum\ParticipationStatus;
use App\Repository\CalendarObjectRepository;
use App\Repository\EventNoteRepository;
use Doctrine\ORM\EntityManagerInterface;
use Sabre\VObject\Component\VCalendar;
use Sabre\VObject\Component\VEvent;
use Sabre\VObject\ITip\Broker;
use Sabre\VObject\ITip\Message as ItipMessage;
use Sabre\VObject\Parameter;
use Sabre\VObject\Property;
use Sabre\VObject\Property\ICalendar\Recur;
use Sabre\VObject\Property\ICalendar\DateTime as DateTimeProperty;
use Sabre\VObject\Settings;
use Symfony\Component\Uid\Uuid;

/**
 * The user's changes to events: create, edit and delete (for recurring events: this occurrence, this and following,
 * or all), and responses to invitations. Every change edits the resource's iCalendar text, so whatever Tresso does not
 * model survives; then the resource is saved (rows, provider write) and attendees or the organizer are told when the
 * calendar's provider does not do that itself. Runs inside the caller's transaction.
 */
final readonly class EventEditor
{
    /** Properties whose change makes an update attendees must act on (RFC 5546 2.1.4). */
    private const array SIGNIFICANT = ['DTSTART', 'DTEND', 'RRULE', 'RDATE', 'EXDATE', 'LOCATION', 'STATUS'];
    private const int MAX_RECURRENCES = 100000;
    /** Asks the provider for an online meeting; the sync worker reads it (see apps/sync googlecal and graphcal). */
    public const string CONFERENCE_REQUEST = 'X-TRESSO-CONFERENCE-REQUEST';

    public function __construct(
        private CalendarStore $store,
        private CalendarObjectRepository $objects,
        private SelfAddresses $selfAddresses,
        private ItipMailer $mailer,
        private SchedulingPermission $permission,
        private EntityManagerInterface $entityManager,
        private EventNoteRepository $notes,
    ) {
        Settings::$maxRecurrences = self::MAX_RECURRENCES;
    }

    public function create(Calendar $calendar, EventChanges $changes, ?MailAccount $organizer, bool $notify = true): CalendarEvent
    {
        self::requireWritable($calendar);
        $uid = Uuid::v7()->toRfc4122().'@tresso';
        $now = new \DateTimeImmutable('now', new \DateTimeZone('UTC'));
        $self = $this->selfAddresses->of($calendar->getOwner());

        $vcalendar = CalendarDocument::create();
        /** @var VEvent $event */
        $event = $vcalendar->add('VEVENT', ['UID' => $uid, 'DTSTAMP' => $now, 'CREATED' => $now, 'SEQUENCE' => 0]);
        $this->write($event, $changes, $vcalendar, true, $self);
        self::withOrganizer($vcalendar, $calendar, $organizer);
        self::requestConference($vcalendar, $calendar, $changes->conferenceProvider);
        // A new event is its own first version.
        Props::set($event, 'SEQUENCE', 0);

        $rows = $this->store->save(new CalendarObject($calendar, $uid, ''), $vcalendar, notify: $notify);
        $this->schedule($calendar, null, $vcalendar, $notify);

        return $rows[''];
    }

    /**
     * @param string|null $recurrenceKey the occurrence the user edited, for recurring events
     */
    public function update(CalendarEvent $row, EventChanges $changes, EditScope $scope, ?string $recurrenceKey, ?Calendar $moveTo = null, bool $notify = true, ?MailAccount $organizer = null): CalendarEvent
    {
        $calendar = $row->getCalendar();
        self::requireWritable($calendar);
        $object = $this->objects->lock($row->getObject());
        $old = CalendarDocument::parse($object->getIcal());
        $vcalendar = CalendarDocument::parse($object->getIcal());
        [$master, $key] = $this->target($vcalendar, $row, $recurrenceKey);
        $self = $this->selfAddresses->of($calendar->getOwner());

        if (null !== $moveTo && !$moveTo->getId()->equals($calendar->getId())) {
            if (null !== $key && EditScope::All !== $scope) {
                throw new EditRejected('Only the whole series can move to another calendar.');
            }
            self::requireWritable($moveTo);

            return $this->move($object, $vcalendar, $old, $master, $changes, $key, $moveTo, $notify, $self, $organizer);
        }

        $editedKey = '';
        $moved = null;
        if (null === $key && null !== $master && self::isSeries($master)) {
            $moved = $this->editAll($vcalendar, $master, $changes, null, $self);
        } elseif (null === $key) {
            $this->write($master ?? throw new EditRejected('This event no longer exists.'), $changes, $vcalendar, true, $self);
        } elseif (EditScope::This === $scope || null === $master) {
            $occurrence = $this->occurrence($vcalendar, $master, $key);
            $this->write($occurrence, $changes, $vcalendar, false, $self);
            $editedKey = $key;
        } elseif (EditScope::All === $scope || $this->isFirst($master, $key)) {
            $moved = $this->editAll($vcalendar, $master, $changes, $key, $self);
        } else {
            $newObject = $this->split($object, $vcalendar, $master, $key, $changes, $self, $notify, $organizer);
            self::withOrganizer($vcalendar, $calendar, $organizer);
            $this->store->save($object, $vcalendar, notify: $notify);
            $this->schedule($calendar, $old, $vcalendar, $notify);

            return $newObject;
        }

        self::withOrganizer($vcalendar, $calendar, $organizer);
        self::requestConference($vcalendar, $calendar, $changes->conferenceProvider);
        // The occurrences moved: their notes go along to the new keys.
        $notes = null === $moved ? [] : $this->liftNotes($object, static fn (string $noteKey): ?string => '' === $noteKey ? null : $moved($noteKey));
        $rows = $this->store->save($object, $vcalendar, notify: $notify);
        $this->putNotes($notes, $rows);
        $this->schedule($calendar, $old, $vcalendar, $notify);

        return $rows[$editedKey] ?? $rows[''] ?? array_values($rows)[0];
    }

    public function delete(CalendarEvent $row, EditScope $scope, ?string $recurrenceKey, bool $notify = true): void
    {
        $calendar = $row->getCalendar();
        self::requireWritable($calendar);
        $object = $this->objects->lock($row->getObject());
        $old = CalendarDocument::parse($object->getIcal());
        $vcalendar = CalendarDocument::parse($object->getIcal());
        [$master, $key] = $this->target($vcalendar, $row, $recurrenceKey);

        if (null === $key || EditScope::All === $scope || (null !== $master && EditScope::Following === $scope && $this->isFirst($master, $key))) {
            $this->store->remove($object, notify: $notify);
            $this->schedule($calendar, $old, null, $notify);

            return;
        }

        if (null === $master) {
            $override = CalendarDocument::override($vcalendar, $key);
            if (null !== $override) {
                $vcalendar->remove($override);
            }
            if ([] === CalendarDocument::events($vcalendar)) {
                $this->store->remove($object, notify: $notify);
                $this->schedule($calendar, $old, null, $notify);

                return;
            }
        } elseif (EditScope::This === $scope) {
            $override = CalendarDocument::override($vcalendar, $key);
            if (null !== $override) {
                $vcalendar->remove($override);
            }
            self::addExdate($master, $key);
            self::touch($master, true);
        } else {
            $this->endBefore($vcalendar, $master, $key);
            self::touch($master, true);
        }

        $this->store->save($object, $vcalendar, notify: $notify);
        $this->schedule($calendar, $old, $vcalendar, $notify);
    }

    /**
     * The owner's answer to an invitation, for the whole series or one occurrence.
     */
    public function respond(CalendarEvent $row, ParticipationStatus $response, ?string $recurrenceKey, ?string $comment, bool $notify = true): CalendarEvent
    {
        $calendar = $row->getCalendar();
        $object = $this->objects->lock($row->getObject());
        $old = CalendarDocument::parse($object->getIcal());
        $vcalendar = CalendarDocument::parse($object->getIcal());
        [$master, $key] = $this->target($vcalendar, $row, $recurrenceKey);
        $self = $this->selfAddresses->of($calendar->getOwner());

        if (null === $key) {
            $components = CalendarDocument::events($vcalendar);
        } else {
            $components = [$this->occurrence($vcalendar, $master, $key)];
        }

        $answered = false;
        foreach ($components as $component) {
            $organizer = Props::get($component, 'ORGANIZER');
            if (null !== $organizer && \in_array(Props::address(Props::value($organizer)), $self, true)) {
                throw new EditRejected('You organize this event, so there is no invitation to answer.');
            }
            foreach (Props::all($component, 'ATTENDEE') as $attendee) {
                if (\in_array(Props::address(Props::value($attendee)), $self, true)) {
                    $attendee['PARTSTAT'] = $response->toICalendar();
                    $attendee->offsetUnset('RSVP');
                    $answered = true;
                }
            }
            // Only LAST-MODIFIED: DTSTAMP stays the organizer's, which their next update is compared with (RFC 5546).
            Props::set($component, 'LAST-MODIFIED', new \DateTimeImmutable('now', new \DateTimeZone('UTC')));
        }
        if (!$answered) {
            throw new EditRejected('You are not among the attendees of this event.');
        }

        // A provider that schedules sends the reply itself: it gets the comment, and whether to send at all.
        $rows = $this->store->save($object, $vcalendar, notify: $notify, comment: null === $comment || '' === trim($comment) ? null : mb_substr(trim($comment), 0, 500));
        if ($notify && $calendar->providerSchedules()) {
            $this->permission->assertMaySend();
        }
        if ($notify && !$calendar->providerSchedules()) {
            $messages = self::itip(self::broker()->parseEvent(clone $vcalendar, self::hrefs($self), clone $old));
            if ([] !== $messages) {
                $this->permission->assertMaySend();
            }
            foreach ($messages as $message) {
                if (null !== $comment && '' !== trim($comment)) {
                    foreach (CalendarDocument::events($message->message) as $event) {
                        Props::set($event, 'COMMENT', trim($comment));
                    }
                }
            }
            $this->mailer->send($calendar->getOwner(), $messages, $row->getMessage());
        }

        return $rows[$key ?? ''] ?? $rows[''] ?? array_values($rows)[0];
    }

    /**
     * The master (when the resource is a series or single event) and the occurrence the change is about (null for the
     * master or a single event).
     *
     * @return array{?VEvent, ?string}
     */
    private function target(VCalendar $vcalendar, CalendarEvent $row, ?string $recurrenceKey): array
    {
        $master = CalendarDocument::master($vcalendar);
        if ($row->isOverride()) {
            return [$master, $row->getRecurrenceKey()];
        }
        if (null === $master) {
            throw new EditRejected('This event no longer exists.');
        }
        if (!self::isSeries($master) || null === $recurrenceKey || '' === $recurrenceKey) {
            return [$master, null];
        }
        if (!RecurrenceKey::isValid($recurrenceKey)) {
            throw new EditRejected('recurrenceId is not a valid occurrence (YYYYMMDD or YYYYMMDDTHHMMSSZ).');
        }

        return [$master, $recurrenceKey];
    }

    /**
     * @param list<string> $self the owner's addresses
     */
    private function write(VEvent $event, EventChanges $changes, VCalendar $vcalendar, bool $withRecurrence, array $self): void
    {
        $before = self::significantState($event);

        self::setText($event, 'SUMMARY', $changes->summary);
        self::setText($event, 'DESCRIPTION', $changes->description);
        self::setText($event, 'LOCATION', $changes->location);
        self::setText($event, 'URL', $changes->url ?? '');
        $event->remove('DURATION');
        self::setTime($event, 'DTSTART', $changes->start, $vcalendar);
        self::setTime($event, 'DTEND', $changes->end, $vcalendar);
        if ($withRecurrence) {
            $event->remove('RRULE');
            if (null !== $changes->rrule) {
                $event->add('RRULE', $changes->rrule);
            }
        }
        Props::set($event, 'STATUS', $changes->status->toICalendar());
        Props::set($event, 'TRANSP', $changes->transparency->toICalendar());
        Props::set($event, 'CLASS', $changes->visibility->toICalendar());
        $this->writeAttendees($event, $changes, $self);
        self::writeReminders($event, $changes);
        self::writeTravel($event, $changes->travelMinutes);
        self::writeImportance($event, $changes->important);
        self::writeConference($event, $changes->conferenceUrl);

        self::touch($event, self::significantState($event) !== $before);
    }

    /**
     * @param list<string> $self
     */
    private function writeAttendees(VEvent $event, EventChanges $changes, array $self): void
    {
        /** @var array<string, Property> $existing */
        $existing = [];
        foreach (Props::all($event, 'ATTENDEE') as $attendee) {
            $existing[Props::address(Props::value($attendee))] = $attendee;
        }
        $event->remove('ATTENDEE');

        foreach ($changes->attendees as $attendee) {
            $previous = $existing[$attendee['address']] ?? null;
            $parameters = [];
            if (null !== $previous) {
                foreach ($previous->parameters() as $name => $parameter) {
                    if (\is_string($name) && $parameter instanceof Parameter) {
                        $parameters[$name] = (string) $parameter;
                    }
                }
            } else {
                $parameters['PARTSTAT'] = 'NEEDS-ACTION';
                $parameters['RSVP'] = 'TRUE';
                $parameters['CUTYPE'] = 'INDIVIDUAL';
            }
            unset($parameters['CN']);
            if (null !== $attendee['name'] && '' !== $attendee['name']) {
                $parameters['CN'] = $attendee['name'];
            }
            $parameters['ROLE'] = match ($attendee['role']) {
                'chair' => 'CHAIR',
                'optional' => 'OPT-PARTICIPANT',
                'non-participant' => 'NON-PARTICIPANT',
                default => 'REQ-PARTICIPANT',
            };
            $event->add('ATTENDEE', 'mailto:'.$attendee['address'], $parameters);
        }

        $organizer = Props::get($event, 'ORGANIZER');
        if ([] === $changes->attendees && null !== $organizer && \in_array(Props::address(Props::value($organizer)), $self, true)) {
            // Without attendees an event the owner organizes is no scheduling object any more.
            $event->remove($organizer);
        }
    }


    /**
     * The alarms the editor shows (relative to the start) are replaced; other clients' alarms stay. With the defaults
     * the event has none of its own, so the user's rules apply; otherwise exactly the given ones, and an explicit
     * marker when that is none.
     */
    private static function writeReminders(VEvent $event, EventChanges $changes): void
    {
        foreach (Props::components($event, 'VALARM') as $alarm) {
            $trigger = Props::get($alarm, 'TRIGGER');
            $relative = null !== $trigger && !$trigger instanceof DateTimeProperty && 'END' !== strtoupper(Props::param($trigger, 'RELATED') ?? 'START');
            if ($relative) {
                $event->remove($alarm);
            }
        }
        $event->remove(EventReader::DEFAULT_REMINDERS);
        if ($changes->useDefaultReminders) {
            return;
        }

        $seen = [];
        foreach ($changes->reminders as $reminder) {
            $minutes = $reminder['minutesBefore'];
            if (isset($seen[$minutes])) {
                continue;
            }
            $seen[$minutes] = true;
            $event->add('VALARM', [
                'ACTION' => 'DISPLAY',
                'DESCRIPTION' => '' === $changes->summary ? 'Reminder' : $changes->summary,
                'TRIGGER' => 0 === $minutes ? 'PT0S' : \sprintf('-PT%dM', $minutes),
                EventReader::CHANNELS => implode(',', $reminder['channels']),
            ]);
        }
        if ([] === $changes->reminders) {
            $event->add(EventReader::DEFAULT_REMINDERS, 'FALSE');
        }
    }

    private static function writeTravel(VEvent $event, ?int $minutes): void
    {
        $event->remove(EventReader::TRAVEL);
        if (null !== $minutes) {
            $event->add(EventReader::TRAVEL, (string) $minutes);
        }
    }

    /**
     * Important is PRIORITY 1 (RFC 5545: 1 to 4 is high). Turning it off removes a high priority and leaves other
     * clients' medium and low ones alone.
     */
    private static function writeImportance(VEvent $event, bool $important): void
    {
        $current = Props::int($event, 'PRIORITY');
        if ($important) {
            Props::set($event, 'PRIORITY', 1);

            return;
        }
        if ($current >= 1 && $current <= 4) {
            $event->remove('PRIORITY');
        }
    }

    /**
     * Google moves an event to another calendar of the account with events.move, which makes that calendar the
     * organizer: guests would see a meeting organized by someone else. A meeting with guests is not moved there.
     */
    private static function refuseOrganizerChange(Calendar $source, Calendar $target, VCalendar $vcalendar): void
    {
        if (CalendarSource::Google !== $source->getSource() || CalendarSource::Google !== $target->getSource() || $source->getMailAccount() !== $target->getMailAccount()) {
            return;
        }
        foreach (CalendarDocument::events($vcalendar) as $event) {
            if ([] !== Props::all($event, 'ATTENDEE')) {
                throw new EditRejected('Google would make the other calendar the organizer of this meeting, and its guests would see that. Keep it in this calendar, or create it again in the other one.');
            }
        }
    }

    /**
     * Asks the calendar's provider for an online meeting: the worker makes it when it writes the event, and the
     * provider's version, with the join link and without this request, then replaces the stored one.
     */
    private static function requestConference(VCalendar $vcalendar, Calendar $calendar, ?string $provider): void
    {
        $master = CalendarDocument::master($vcalendar);
        if (null === $provider || null === $master) {
            return;
        }
        if (!\in_array($provider, $calendar->getConferenceProviders(), true)) {
            throw new EditRejected(\sprintf('This calendar cannot make %s meetings.', 'meet' === $provider ? 'Google Meet' : 'Microsoft Teams'));
        }
        if (null !== ConferenceDetector::detect($master)) {
            return;
        }
        Props::set($master, self::CONFERENCE_REQUEST, $provider);
    }

    private static function writeConference(VEvent $event, ?string $url): void
    {
        $existing = null;
        foreach (Props::all($event, 'CONFERENCE') as $conference) {
            $value = trim(Props::value($conference));
            if (str_starts_with(strtolower($value), 'https://')) {
                $existing = $conference;
            }
        }
        if (null !== $existing && $url === trim(Props::value($existing))) {
            return;
        }
        if (null !== $existing) {
            $event->remove($existing);
        }
        if (null !== $url) {
            $event->add('CONFERENCE', $url, ['VALUE' => 'URI', 'FEATURE' => 'VIDEO']);
        }
    }

    /**
     * "All occurrences": the series moves by the same shift the user gave the edited occurrence, and its overrides and
     * exceptions move with it. A new recurrence rule, or a switch between all-day and timed, starts the series fresh.
     * Returns where each occurrence key went when the occurrences moved, else null.
     *
     * @param list<string> $self
     *
     * @return (\Closure(string): ?string)|null
     */
    private function editAll(VCalendar $vcalendar, VEvent $master, EventChanges $changes, ?string $key, array $self): ?\Closure
    {
        $masterStart = EventReader::time(self::dtStart($master), $vcalendar);
        $anchor = null === $key ? $masterStart : $this->occurrenceStart($master, $key, $vcalendar);
        $oldRule = Props::text($master, 'RRULE');

        $sameKind = $anchor->isDate === $changes->start->isDate;
        $shift = $sameKind ? self::wallClockSeconds($changes->start) - self::wallClockSeconds($anchor) : 0;
        $length = self::wallClockSeconds($changes->end) - self::wallClockSeconds($changes->start);

        if ($sameKind) {
            $newStart = self::shiftTime($masterStart, $shift, $changes->start->timeZone);
        } else {
            $newStart = $changes->start->isDate
                ? EventTime::date(self::wallClock($masterStart))
                : EventTime::dateTime(new \DateTimeImmutable(self::wallClock($masterStart)->format('Y-m-d').' '.self::wallClock($changes->start)->format('H:i:s'), new \DateTimeZone('UTC')), $changes->start->timeZone);
        }
        // The end keeps its own zone (a flight that lands in another one); the editor's length is between wall clocks.
        $newEnd = self::shiftTime($newStart, $length, $sameKind ? $changes->end->timeZone : $newStart->timeZone);

        $fresh = !$sameKind || self::normalizeRule($changes->rrule) !== self::normalizeRule($oldRule);
        // Moved to another day with the rule left alone: the weekdays and days of the month move along, so the series
        // repeats on the new day, and its exceptions, moved by the same shift, still match.
        $rule = $fresh ? $changes->rrule : self::shiftRule($changes->rrule, self::daysBetween($anchor, $changes->start), $changes->start);
        $overrides = array_filter(CalendarDocument::events($vcalendar), static fn (VEvent $event): bool => '' !== CalendarDocument::recurrenceKey($event));
        $moved = null;
        if ($fresh) {
            foreach ($overrides as $override) {
                $vcalendar->remove($override);
            }
            $master->remove('EXDATE');
            $master->remove('RDATE');
        } elseif (0 !== $shift || $changes->start->timeZone !== $masterStart->timeZone) {
            $moved = self::keyMover($masterStart, $shift, $changes->start->timeZone);
            foreach ($overrides as $override) {
                $atItsTime = self::atItsOwnTime($override);
                self::shiftProperty(Props::dateTime($override, 'RECURRENCE-ID'), $shift, $masterStart->timeZone, $changes->start->timeZone, $vcalendar);
                if ($atItsTime) {
                    // Changed in other ways only: it moves with the series.
                    self::shiftProperty(Props::dateTime($override, 'DTSTART'), $shift, $masterStart->timeZone, $changes->start->timeZone, $vcalendar);
                    self::shiftProperty(Props::dateTime($override, 'DTEND'), $shift, $masterStart->timeZone, $changes->start->timeZone, $vcalendar);
                }
            }
            foreach ([...Props::dateTimes($master, 'EXDATE'), ...Props::dateTimes($master, 'RDATE')] as $property) {
                self::shiftProperty($property, $shift, $masterStart->timeZone, $changes->start->timeZone, $vcalendar);
            }
        }

        $this->write($master, new EventChanges(
            $changes->summary, $changes->description, $changes->location, $changes->url, $newStart, $newEnd, $rule,
            $changes->status, $changes->transparency, $changes->visibility, $changes->attendees, $changes->reminders, $changes->conferenceUrl,
            $changes->useDefaultReminders, $changes->travelMinutes, $changes->important,
        ), $vcalendar, true, $self);

        return $moved;
    }

    /**
     * "This and following": the series ends before the occurrence, and a new series with a new UID starts there with
     * the user's changes, taking the later overrides and exceptions along.
     */
    /**
     * @param list<string> $self
     */
    private function split(CalendarObject $object, VCalendar $vcalendar, VEvent $master, string $key, EventChanges $changes, array $self, bool $notify, ?MailAccount $organizer): CalendarEvent
    {
        $occurrence = $this->occurrenceStart($master, $key, $vcalendar);
        $oldRule = Props::text($master, 'RRULE');
        $remaining = $this->remainingCount($master, $key);

        $uid = Uuid::v7()->toRfc4122().'@tresso';
        $next = CalendarDocument::create();
        $newMaster = clone $master;
        Props::set($newMaster, 'UID', $uid);
        $newMaster->remove('EXDATE');
        $newMaster->remove('RDATE');
        $newMaster->remove('RECURRENCE-ID');
        $next->add($newMaster);
        foreach (Props::components($vcalendar, 'VTIMEZONE') as $zone) {
            $next->add(clone $zone);
        }

        $sameKind = $occurrence->isDate === $changes->start->isDate;
        $shift = $sameKind ? self::wallClockSeconds($changes->start) - self::wallClockSeconds($occurrence) : 0;
        // Notes on this and later occurrences go to the new series, at the keys their occurrences get there.
        $mover = $sameKind ? self::keyMover(EventReader::time(self::dtStart($master), $vcalendar), $shift, $changes->start->timeZone) : null;
        $notes = $this->liftNotes($object, static fn (string $noteKey): ?string => '' === $noteKey || $noteKey < $key ? null : ((null === $mover ? null : $mover($noteKey)) ?? $noteKey));
        // The new series starts where the occurrence belongs in the series, moved as far as the user moved what was
        // shown: from a moved occurrence its override's own time is not the series' time. Its override goes along,
        // moved by the same shift, so it still matches its occurrence.
        if ($sameKind) {
            $start = self::shiftTime($this->keyStart($master, $key, $vcalendar), $shift, $changes->start->timeZone);
            $end = self::shiftTime($start, self::wallClockSeconds($changes->end) - self::wallClockSeconds($changes->start), $changes->end->timeZone);
        } else {
            $start = $changes->start;
            $end = $changes->end;
        }

        $edited = null;
        foreach (CalendarDocument::events($vcalendar) as $override) {
            $overrideKey = CalendarDocument::recurrenceKey($override);
            if ('' === $overrideKey || $overrideKey < $key) {
                continue;
            }
            $vcalendar->remove($override);
            if (!$sameKind) {
                continue;
            }
            $moved = clone $override;
            Props::set($moved, 'UID', $uid);
            $atItsTime = self::atItsOwnTime($moved);
            self::shiftProperty(Props::dateTime($moved, 'RECURRENCE-ID'), $shift, $occurrence->timeZone, $changes->start->timeZone, $next);
            if (($overrideKey === $key || $atItsTime) && 0 !== $shift) {
                // The occurrence the user edited shows where they put it; others not moved before move along.
                self::shiftProperty(Props::dateTime($moved, 'DTSTART'), $shift, $occurrence->timeZone, $changes->start->timeZone, $next);
                self::shiftProperty(Props::dateTime($moved, 'DTEND'), $shift, $occurrence->timeZone, $changes->start->timeZone, $next);
            }
            $next->add($moved);
            if ($overrideKey === $key) {
                $edited = $moved;
            }
        }
        foreach (['EXDATE', 'RDATE'] as $name) {
            foreach (Props::dateTimes($master, $name) as $property) {
                $later = array_values(array_filter($property->getDateTimes(new \DateTimeZone('UTC')), static fn (\DateTimeInterface $value): bool => ($property->hasTime() ? RecurrenceKey::fromInstant($value) : RecurrenceKey::fromDate($value)) >= $key));
                if ([] !== $later && $sameKind) {
                    $copy = $newMaster->add($name, $later, $property->hasTime() ? [] : ['VALUE' => 'DATE']);
                    if ($copy instanceof DateTimeProperty) {
                        self::shiftProperty($copy, $shift, $occurrence->timeZone, $changes->start->timeZone, $next);
                    }
                }
            }
        }

        $this->endBefore($vcalendar, $master, $key);
        self::touch($master, true);

        $rule = $changes->rrule;
        if (self::normalizeRule($rule) === self::normalizeRule($oldRule)) {
            if (null !== $remaining) {
                $rule = self::withCount((string) $oldRule, $remaining);
            }
            $rule = $sameKind ? self::shiftRule($rule, self::daysBetween($occurrence, $changes->start), $changes->start) : $rule;
        }
        Props::set($newMaster, 'SEQUENCE', 0);
        $this->write($newMaster, new EventChanges(
            $changes->summary, $changes->description, $changes->location, $changes->url, $start, $end, $rule,
            $changes->status, $changes->transparency, $changes->visibility, $changes->attendees, $changes->reminders, $changes->conferenceUrl,
            $changes->useDefaultReminders, $changes->travelMinutes, $changes->important,
        ), $next, true, $self);
        if (null !== $edited) {
            // The occurrence the user edited was changed before: its override replaces the new series' first
            // occurrence, so it takes the edit too, at the time the user gave it. Per-occurrence answers of guests stay.
            $this->write($edited, new EventChanges(
                $changes->summary, $changes->description, $changes->location, $changes->url, $changes->start, $changes->end, null,
                $changes->status, $changes->transparency, $changes->visibility, $changes->attendees, $changes->reminders, $changes->conferenceUrl,
                $changes->useDefaultReminders, $changes->travelMinutes, $changes->important,
            ), $next, false, $self);
        }
        self::withOrganizer($next, $object->getCalendar(), $organizer);
        self::requestConference($next, $object->getCalendar(), $changes->conferenceProvider);

        $rows = $this->store->save(new CalendarObject($object->getCalendar(), $uid, ''), $next, notify: $notify);
        $this->putNotes($notes, $rows);
        $this->schedule($object->getCalendar(), null, $next, $notify);

        return $rows[''];
    }

    /**
     * @param list<string> $self
     */
    private function move(CalendarObject $object, VCalendar $vcalendar, VCalendar $old, ?VEvent $master, EventChanges $changes, ?string $key, Calendar $target, bool $notify, array $self, ?MailAccount $organizer): CalendarEvent
    {
        $moved = null;
        if (null !== $master) {
            if (null === $key) {
                $this->write($master, $changes, $vcalendar, true, $self);
            } else {
                $moved = $this->editAll($vcalendar, $master, $changes, $key, $self);
            }
        }
        if (null !== $this->objects->findOneByUid($target, $object->getUid())) {
            throw new EditRejected('The other calendar already has this event.');
        }
        self::refuseOrganizerChange($object->getCalendar(), $target, $vcalendar);
        self::withOrganizer($vcalendar, $target, $organizer);
        self::requestConference($vcalendar, $target, $changes->conferenceProvider);
        $source = $object->getCalendar();
        // Every note goes along to the new resource (removing the old one would delete them).
        $notes = $this->liftNotes($object, static fn (string $noteKey): string => '' === $noteKey ? '' : ((null === $moved ? null : $moved($noteKey)) ?? $noteKey));
        $this->store->remove($object, notify: $notify && $source->getMailAccount() !== $target->getMailAccount());
        $rows = $this->store->save(new CalendarObject($target, $object->getUid(), ''), $vcalendar, notify: $notify);
        $this->putNotes($notes, $rows);
        $this->schedule($source, $old, null, $notify && $source->getMailAccount() !== $target->getMailAccount());
        $this->schedule($target, $source->getMailAccount() === $target->getMailAccount() ? $old : null, $vcalendar, $notify);

        return $rows[''];
    }

    /**
     * Every component with attendees names an organizer, or no invitation goes out (sabre schedules from it): the
     * event's own organizer when it has one, else the chosen account, else the calendar's account. An existing
     * organizer is never replaced.
     */
    private static function withOrganizer(VCalendar $vcalendar, Calendar $calendar, ?MailAccount $chosen): void
    {
        $existing = null;
        foreach (CalendarDocument::events($vcalendar) as $event) {
            $existing ??= Props::get($event, 'ORGANIZER');
        }
        foreach (CalendarDocument::events($vcalendar) as $event) {
            if ([] === Props::all($event, 'ATTENDEE') || null !== Props::get($event, 'ORGANIZER')) {
                continue;
            }
            if (null !== $existing) {
                $event->add(clone $existing);
                continue;
            }
            $account = $chosen ?? $calendar->getMailAccount() ?? throw new EditRejected('Choose the mail account that sends the invitations.');
            $existing = $event->add('ORGANIZER', 'mailto:'.$account->getEmailAddress(), ['CN' => $account->getDisplayName()]);
        }
    }

    /**
     * Tells attendees about the organizer's change, after the change was saved in the same transaction: when the
     * caller may not send mail ({@see SchedulingPermission}) the whole change is refused and rolled back. That looks at
     * the whole calendar object, the series with every changed occurrence, so a guest added to one occurrence counts
     * when the series is changed or deleted. A provider that schedules sends the mail itself, for any event that has or
     * had guests.
     */
    private function schedule(Calendar $calendar, ?VCalendar $old, ?VCalendar $new, bool $notify): void
    {
        if (!$notify) {
            return;
        }
        if ($calendar->providerSchedules()) {
            if (self::hasAttendees($old) || self::hasAttendees($new)) {
                $this->permission->assertMaySend();
            }

            return;
        }
        $self = $this->selfAddresses->of($calendar->getOwner());
        // A null new object is how sabre's broker learns about a deletion; its docblock leaves that case out.
        /** @phpstan-ignore argument.type */
        $messages = self::itip(self::broker()->parseEvent(null === $new ? null : clone $new, self::hrefs($self), null === $old ? null : clone $old));
        // Only the organizer's side: attendees reply through respond(), never as a side effect of editing.
        $organizerMessages = array_values(array_filter($messages, static fn (ItipMessage $message): bool => \in_array($message->method, ['REQUEST', 'CANCEL'], true)));
        if ([] === $organizerMessages) {
            return;
        }
        $this->permission->assertMaySend();
        $this->mailer->send($calendar->getOwner(), $organizerMessages);
    }

    private static function hasAttendees(?VCalendar $calendar): bool
    {
        if (null === $calendar) {
            return false;
        }
        foreach (CalendarDocument::events($calendar) as $event) {
            if ([] !== Props::all($event, 'ATTENDEE')) {
                return true;
            }
        }

        return false;
    }


    private function occurrence(VCalendar $vcalendar, ?VEvent $master, string $key): VEvent
    {
        $existing = CalendarDocument::override($vcalendar, $key);
        if (null !== $existing) {
            return $existing;
        }
        if (null === $master) {
            throw new EditRejected('This occurrence no longer exists.');
        }
        try {
            return Occurrences::override($vcalendar, $master, $key);
        } catch (InvalidCalendarData $e) {
            throw new EditRejected($e->getMessage(), previous: $e);
        }
    }

    /**
     * Where the occurrence is: an override's own start when it was moved (the time the user sees and edits from),
     * else the series' time at its recurrence id.
     */
    private function occurrenceStart(VEvent $master, string $key, VCalendar $vcalendar): EventTime
    {
        $override = CalendarDocument::override($vcalendar, $key);
        if (null !== $override) {
            return EventReader::time(self::dtStart($override), $vcalendar);
        }

        return $this->keyStart($master, $key, $vcalendar);
    }

    /** Where the occurrence with this key belongs in the series: its recurrence id as a time of the series. */
    private function keyStart(VEvent $master, string $key, VCalendar $vcalendar): EventTime
    {
        return self::keyTime(EventReader::time(self::dtStart($master), $vcalendar), $key);
    }

    /** The occurrence with this key as a time of a series that starts at $seriesStart. */
    private static function keyTime(EventTime $seriesStart, string $key): EventTime
    {
        $instant = RecurrenceKey::require($key);
        if ($seriesStart->isDate) {
            return EventTime::date($instant);
        }
        if (null === $seriesStart->timeZone) {
            return EventTime::dateTime($instant, null);
        }

        return EventTime::dateTime($instant->setTimezone(new \DateTimeZone($seriesStart->timeZone)), $seriesStart->timeZone);
    }

    /**
     * Where the occurrences of a series that starts at $seriesStart go when the series moves by $shift seconds of
     * wall clock into $zone, as its overrides and exceptions do: old key to new key (null for a key that is none).
     *
     * @return \Closure(string): ?string
     */
    private static function keyMover(EventTime $seriesStart, int $shift, ?string $zone): \Closure
    {
        return static function (string $key) use ($seriesStart, $shift, $zone): ?string {
            if (!RecurrenceKey::isValid($key)) {
                return null;
            }
            $time = self::shiftTime(self::keyTime($seriesStart, $key), $shift, $zone);
            $instant = $time->toInstant(new \DateTimeZone('UTC'));

            return $time->isDate ? RecurrenceKey::fromDate($instant) : RecurrenceKey::fromInstant($instant);
        };
    }

    /**
     * Takes the object's notes off their rows before the rows change under them, for every note $to gives a key
     * (null leaves the note where it is); {@see putNotes()} hangs them on the rows that show those occurrences after
     * the save. They are removed first (and leave tombstones), so no row and key is ever held twice on the way.
     *
     * @param \Closure(string): ?string $to
     *
     * @return list<array{string, string}> each note's text and its new occurrence key
     */
    private function liftNotes(CalendarObject $object, \Closure $to): array
    {
        $lifted = [];
        foreach ($this->notes->findForObject($object) as $note) {
            $key = $to($note->getOccurrenceKey());
            if (null === $key) {
                continue;
            }
            $lifted[] = [$note->getText(), $key];
            $this->entityManager->remove($note);
        }
        if ([] !== $lifted) {
            $this->entityManager->flush();
        }

        return $lifted;
    }

    /**
     * @param list<array{string, string}>  $lifted from {@see liftNotes()}
     * @param array<string, CalendarEvent> $rows   the saved object's rows by recurrence key
     */
    private function putNotes(array $lifted, array $rows): void
    {
        if ([] === $lifted || [] === $rows) {
            return;
        }
        /** @var array<string, EventNote> $placed */
        $placed = [];
        foreach ($lifted as [$text, $key]) {
            // The override that shows the occurrence, else the series; a key no row shows stays on the first row.
            $row = ('' !== $key ? ($rows[$key] ?? null) : null) ?? $rows[''] ?? array_values($rows)[0];
            $slot = $row->getId()->toRfc4122().'|'.$key;
            $note = $placed[$slot] ?? $this->notes->findFor($row, $key);
            if (null === $note) {
                $note = new EventNote($row, $key);
                $note->write($text);
                $this->entityManager->persist($note);
            } else {
                // Two notes for one occurrence: joined, so no text is lost.
                $note->write(rtrim($note->getText())."\n\n".$text);
            }
            $placed[$slot] = $note;
        }
        $this->entityManager->flush();
    }

    private function isFirst(VEvent $master, string $key): bool
    {
        return RecurrenceKey::fromProperty(self::dtStart($master)) >= $key;
    }

    /** Ends the series just before the occurrence and drops whatever belonged to the later part. */
    private function endBefore(VCalendar $vcalendar, VEvent $master, string $key): void
    {
        $start = self::dtStart($master);
        $instant = RecurrenceKey::require($key);
        // UNTIL takes the form of DTSTART (RFC 5545 3.3.10): a date, a floating time (the key is its wall clock), or UTC.
        $until = match (true) {
            !$start->hasTime() => $instant->modify('-1 day')->format('Ymd'),
            $start->isFloating() => $instant->modify('-1 second')->format('Ymd\THis'),
            default => $instant->modify('-1 second')->format('Ymd\THis\Z'),
        };

        $rule = Props::get($master, 'RRULE');
        if ($rule instanceof Recur) {
            $parts = $rule->getParts();
            unset($parts['COUNT']);
            $parts['UNTIL'] = $until;
            $rule->setParts($parts);
        }
        foreach (['EXDATE', 'RDATE'] as $name) {
            foreach (Props::dateTimes($master, $name) as $property) {
                $kept = array_values(array_filter($property->getDateTimes(), static fn (\DateTimeInterface $value): bool => ($property->hasTime() ? RecurrenceKey::fromInstant($value) : RecurrenceKey::fromDate($value)) < $key));
                if ([] === $kept) {
                    $master->remove($property);
                } else {
                    $property->setDateTimes($kept, $property->isFloating());
                }
            }
        }
        foreach (CalendarDocument::events($vcalendar) as $override) {
            $overrideKey = CalendarDocument::recurrenceKey($override);
            if ('' !== $overrideKey && $overrideKey >= $key) {
                $vcalendar->remove($override);
            }
        }
    }

    /** For a series with COUNT: how many occurrences are left from the occurrence on. */
    private function remainingCount(VEvent $master, string $key): ?int
    {
        $rule = Props::get($master, 'RRULE');
        $count = $rule instanceof Recur ? ($rule->getParts()['COUNT'] ?? null) : null;
        if (!is_numeric($count)) {
            return null;
        }
        // COUNT counts the rule's occurrences before EXDATE takes any away, and not the RDATEs (RFC 5545 3.3.10).
        $before = Occurrences::ruleOccurrencesBefore($master, $key, new \DateTimeZone('UTC')) ?? 0;

        return max(1, (int) $count - $before);
    }

    private static function withCount(string $rule, int $count): string
    {
        $parts = [];
        foreach (explode(';', $rule) as $part) {
            if ('' !== $part && !str_starts_with(strtoupper($part), 'COUNT=') && !str_starts_with(strtoupper($part), 'UNTIL=')) {
                $parts[] = $part;
            }
        }
        $parts[] = 'COUNT='.$count;

        return implode(';', $parts);
    }

    private static function addExdate(VEvent $master, string $key): void
    {
        $start = self::dtStart($master);
        $instant = RecurrenceKey::require($key);
        if (!$start->hasTime()) {
            $master->add('EXDATE', $instant, ['VALUE' => 'DATE']);

            return;
        }
        if ($start->isFloating()) {
            $exdate = $master->add('EXDATE', $instant);
            if ($exdate instanceof DateTimeProperty) {
                $exdate->setDateTime($instant, true);
            }

            return;
        }
        $master->add('EXDATE', $instant->setTimezone($start->getDateTime()->getTimezone()));
    }

    private static function dtStart(VEvent $event): DateTimeProperty
    {
        return Props::dateTime($event, 'DTSTART') ?? throw new EditRejected('The event has no start.');
    }

    private static function setTime(VEvent $event, string $name, EventTime $time, VCalendar $vcalendar): void
    {
        $event->remove($name);
        $utc = new \DateTimeZone('UTC');
        if ($time->isDate) {
            $event->add($name, $time->toInstant($utc), ['VALUE' => 'DATE']);

            return;
        }
        $instant = $time->toInstant($utc);
        if (null === $time->timeZone) {
            $property = $event->add($name, $instant);
            if ($property instanceof DateTimeProperty) {
                $property->setDateTime($instant, true);
            }

            return;
        }
        $event->add($name, $instant);
        VTimezoneBuilder::ensure($vcalendar, $time->timeZone, $instant);
    }

    /**
     * Moves a date or date-time property by a number of wall-clock seconds of the series, from its zone ($from) into
     * another ($zone). Values given in UTC are read on the series' wall clock first, so they move with the series and
     * stay in UTC.
     */
    private static function shiftProperty(?DateTimeProperty $property, int $seconds, ?string $from, ?string $zone, VCalendar $vcalendar): void
    {
        if (null === $property) {
            return;
        }
        $zoned = $property->hasTime() && !$property->isFloating();
        $utc = $zoned && null === Props::param($property, 'TZID');
        $values = [];
        foreach ($property->getDateTimes(new \DateTimeZone('UTC')) as $value) {
            if ($utc && null !== $from) {
                $value = \DateTimeImmutable::createFromInterface($value)->setTimezone(new \DateTimeZone($from));
            }
            $wallClock = new \DateTimeImmutable($value->format('Y-m-d H:i:s'), new \DateTimeZone('UTC'))->modify(\sprintf('%+d seconds', $seconds));
            $shifted = $zoned && null !== ($zone ?? $from)
                ? new \DateTimeImmutable($wallClock->format('Y-m-d H:i:s'), new \DateTimeZone($zone ?? $from))
                : $wallClock;
            $values[] = $utc ? $shifted->setTimezone(new \DateTimeZone('UTC')) : $shifted;
        }
        if (!$property->hasTime()) {
            $property->setDateTimes($values);
            $property['VALUE'] = 'DATE';

            return;
        }
        $property->setDateTimes($values, $property->isFloating());
        if (!$utc && null !== $zone && !$property->isFloating() && 'UTC' !== $zone) {
            VTimezoneBuilder::ensure($vcalendar, $zone, $values[0]);
        }
    }

    private static function shiftTime(EventTime $time, int $seconds, ?string $zone): EventTime
    {
        $shifted = self::wallClock($time)->modify(\sprintf('%+d seconds', $seconds));

        return $time->isDate ? EventTime::date($shifted) : EventTime::dateTime($shifted, $zone);
    }

    private static function wallClock(EventTime $time): \DateTimeImmutable
    {
        return $time->toInstant(new \DateTimeZone('UTC'))->setTimezone(new \DateTimeZone($time->timeZone ?? 'UTC'));
    }

    private static function wallClockSeconds(EventTime $time): int
    {
        return new \DateTimeImmutable(self::wallClock($time)->format('Y-m-d H:i:s'), new \DateTimeZone('UTC'))->getTimestamp();
    }

    /** Whether an override still starts at the time of the occurrence it changes (it changed other things). */
    private static function atItsOwnTime(VEvent $override): bool
    {
        $recurrenceId = Props::dateTime($override, 'RECURRENCE-ID');
        $start = Props::dateTime($override, 'DTSTART');
        if (null === $recurrenceId || null === $start || $recurrenceId->hasTime() !== $start->hasTime()) {
            return false;
        }
        $utc = new \DateTimeZone('UTC');

        return $recurrenceId->getDateTime($utc)->getTimestamp() === $start->getDateTime($utc)->getTimestamp();
    }

    /** Calendar days from one time's date to another's, on their clocks. */
    private static function daysBetween(EventTime $from, EventTime $to): int
    {
        $day = static fn (EventTime $time): int => (int) floor(self::wallClock($time)->setTime(0, 0)->getTimestamp() / 86400);

        return $day($to) - $day($from);
    }

    /**
     * A rule moved with its series by a number of days: a single weekday moves along (BYDAY=MO by one day is BYDAY=TU,
     * while a list such as every weekday stays as it is), and
     * a monthly or yearly rule takes the day of the month, the week of the month or the month of the day it moved
     * to. Parts that cannot move as one (several days of the month, BYSETPOS) are left as they are.
     */
    private static function shiftRule(?string $rule, int $days, EventTime $to): ?string
    {
        if (null === $rule || 0 === $days) {
            return $rule;
        }
        $codes = ['SU', 'MO', 'TU', 'WE', 'TH', 'FR', 'SA'];
        $target = self::wallClock($to);
        $parts = explode(';', $rule);
        $freq = '';
        foreach ($parts as $part) {
            if (str_starts_with(strtoupper($part), 'FREQ=')) {
                $freq = strtoupper(substr($part, 5));
            }
        }
        $weekday = $codes[(int) $target->format('w')];
        $week = intdiv((int) $target->format('j') - 1, 7) + 1;
        $isLast = $target->modify('+7 days')->format('n') !== $target->format('n');

        foreach ($parts as $index => $part) {
            [$name, $value] = array_pad(explode('=', $part, 2), 2, '');
            $name = strtoupper($name);
            if ('BYDAY' === $name) {
                $weekdays = explode(',', strtoupper($value));
                if ('MONTHLY' === $freq || 'YEARLY' === $freq) {
                    if (1 === \count($weekdays) && 1 === preg_match('/^([+-]?\d+)[A-Z]{2}$/', $weekdays[0], $match)) {
                        $ordinal = ((int) $match[1] < 0 && $isLast) || 5 === $week ? -1 : $week;
                        $parts[$index] = 'BYDAY='.$ordinal.$weekday;
                    }
                    continue;
                }
                // One weekday moves with the series. A list of them (every weekday, Monday and Thursday) stays: moving one
                // occurrence by a day does not make Saturday a weekday.
                if (1 === \count($weekdays) && 1 === preg_match('/^([+-]?\d+)?([A-Z]{2})$/', $weekdays[0], $match)) {
                    $at = array_search($match[2], $codes, true);
                    if (false !== $at) {
                        $parts[$index] = 'BYDAY='.$match[1].$codes[(($at + $days) % 7 + 7) % 7];
                    }
                }
            } elseif ('BYMONTHDAY' === $name && !str_contains($value, ',') && (int) $value > 0) {
                $parts[$index] = 'BYMONTHDAY='.$target->format('j');
            } elseif ('BYMONTH' === $name && 'YEARLY' === $freq && !str_contains($value, ',')) {
                $parts[$index] = 'BYMONTH='.$target->format('n');
            }
        }

        return implode(';', $parts);
    }

    private static function normalizeRule(?string $rule): ?string
    {
        if (null === $rule || '' === trim($rule)) {
            return null;
        }
        $parts = array_filter(explode(';', strtoupper(trim($rule))));
        sort($parts);

        return implode(';', $parts);
    }

    private static function touch(VEvent $event, bool $significant): void
    {
        $now = new \DateTimeImmutable('now', new \DateTimeZone('UTC'));
        Props::set($event, 'LAST-MODIFIED', $now);
        Props::set($event, 'DTSTAMP', $now);
        if ($significant) {
            Props::set($event, 'SEQUENCE', Props::int($event, 'SEQUENCE') + 1);
        }
    }

    private static function significantState(VEvent $event): string
    {
        $state = [];
        foreach (self::SIGNIFICANT as $name) {
            foreach (Props::all($event, $name) as $property) {
                $state[] = $property->serialize();
            }
        }

        return implode('|', $state);
    }

    private static function setText(VEvent $event, string $name, string $value): void
    {
        $event->remove($name);
        if ('' !== trim($value)) {
            $event->add($name, $value);
        }
    }

    /**
     * sabre's broker, judging "significant" as the editor does: sabre leaves LOCATION out, so a new place would raise
     * SEQUENCE without the guests being told.
     */
    private static function broker(): Broker
    {
        $broker = new Broker();
        $broker->significantChangeProperties = array_values(array_unique([...$broker->significantChangeProperties, ...self::SIGNIFICANT]));

        return $broker;
    }

    /**
     * @param list<string> $addresses
     *
     * @return list<string>
     */
    private static function hrefs(array $addresses): array
    {
        return array_map(static fn (string $address): string => 'mailto:'.$address, $addresses);
    }

    private static function isSeries(VEvent $master): bool
    {
        return null !== Props::get($master, 'RRULE') || null !== Props::get($master, 'RDATE');
    }

    /**
     * @param array<mixed> $messages
     *
     * @return list<ItipMessage>
     */
    private static function itip(array $messages): array
    {
        return array_values(array_filter($messages, static fn (mixed $message): bool => $message instanceof ItipMessage));
    }

    private static function requireWritable(Calendar $calendar): void
    {
        if (!$calendar->isWritable()) {
            throw new EditRejected('This calendar is read-only.');
        }
    }
}
