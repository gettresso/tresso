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
use App\Entity\MailAccount;
use App\Enum\CalendarSource;
use App\Enum\EditScope;
use App\Enum\ParticipationStatus;
use App\Repository\CalendarEventRepository;
use App\Repository\CalendarObjectRepository;
use Psr\Clock\ClockInterface;
use Sabre\VObject\Component\VCalendar;
use Sabre\VObject\Component\VEvent;
use Sabre\VObject\ITip\Broker;
use Sabre\VObject\ITip\Message as ItipMessage;
use Sabre\VObject\Parameter;
use Sabre\VObject\Property;
use Sabre\VObject\Property\ICalendar\CalAddress;
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
    private const array SIGNIFICANT = ['DTSTART', 'DTEND', 'RRULE', 'RDATE', 'EXDATE', 'LOCATION', 'STATUS', 'CONFERENCE'];
    private const int MAX_RECURRENCES = 100000;
    /** Asks the provider for an online meeting; the sync worker reads it (see apps/sync googlecal and graphcal). */
    public const string CONFERENCE_REQUEST = 'X-TRESSO-CONFERENCE-REQUEST';
    /**
     * The request's own id next to it: a new request (after a removal, a failure or a long wait) gets a new one, which
     * the worker turns into a new provider request id, so the provider makes a new meeting instead of ignoring it.
     */
    public const string CONFERENCE_NONCE = 'X-TRESSO-CONFERENCE-NONCE';
    /** A request younger than this is still on its way: asking again changes nothing. */
    public const int CONFERENCE_PENDING_SECONDS = 120;
    /**
     * Written on the master when Tresso took a Google Meet meeting off the event: the worker then sends
     * `conferenceData: null`, and only then (a master that merely lacks X-GOOGLE-CONFERENCE is no reason to remove
     * Google's meeting). Google's version drops it, as it drops the request; a new request clears it.
     */
    public const string CONFERENCE_REMOVE = 'X-TRESSO-CONFERENCE-REMOVE';
    private const string TEAMS_STAYS = 'Microsoft keeps a Teams meeting on its event. Delete the event to cancel the meeting.';
    private const string ORGANIZER_ONLY = 'Only the organizer can change the meeting link.';
    private const string TEXT_LINK = 'This link is part of the event\'s text. Remove it there.';

    public function __construct(
        private CalendarStore $store,
        private CalendarObjectRepository $objects,
        private SelfAddresses $selfAddresses,
        private ItipMailer $mailer,
        private SchedulingPermission $permission,
        private EventNotes $notes,
        private ClockInterface $clock,
        private CalendarEventRepository $events,
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
        $this->write($event, $changes, $vcalendar, $calendar, true, $self);
        self::withOrganizer($vcalendar, $calendar, $organizer);
        $object = new CalendarObject($calendar, $uid, '');
        $this->requestConference($object, $vcalendar, $calendar, $changes->conferenceProvider);
        // A new event is its own first version.
        Props::set($event, 'SEQUENCE', 0);

        $rows = $this->store->save($object, $vcalendar, notify: $notify);
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
            // A resource without its series (an invitation to one occurrence) has nothing to split from: it moves whole.
            if (null !== $key && null !== $master && EditScope::All !== $scope) {
                throw new EditRejected('Only the whole series can move to another calendar.');
            }
            self::requireWritable($moveTo);

            return $this->move($object, $vcalendar, $old, $master, $changes, $key, $moveTo, $notify, $self, $organizer);
        }

        $editedKey = '';
        $moved = null;
        if (null === $key && null !== $master && self::isSeries($master)) {
            $moved = $this->editAll($vcalendar, $calendar, $master, $changes, null, $self);
        } elseif (null === $key) {
            $this->write($master ?? throw new EditRejected('This event no longer exists.'), $changes, $vcalendar, $calendar, true, $self);
        } elseif (EditScope::This === $scope || null === $master) {
            $occurrence = $this->occurrence($vcalendar, $master, $key);
            $this->write($occurrence, $changes, $vcalendar, $calendar, false, $self);
            $editedKey = $key;
        } elseif (EditScope::All === $scope || $this->isFirst($master, $key)) {
            $moved = $this->editAll($vcalendar, $calendar, $master, $changes, $key, $self);
        } else {
            $newObject = $this->split($object, $vcalendar, $master, $key, $changes, $self, $notify, $organizer);
            self::withOrganizer($vcalendar, $calendar, $organizer);
            $this->store->save($object, $vcalendar, notify: $notify);
            $this->schedule($calendar, $old, $vcalendar, $notify);

            return $newObject;
        }

        self::withOrganizer($vcalendar, $calendar, $organizer);
        // An edit of one occurrence is not about the series' meeting: it neither asks for one nor drops the request
        // (an override row carries none, so its client sends none).
        if ('' === $editedKey || null !== $changes->conferenceProvider) {
            $this->requestConference($object, $vcalendar, $calendar, $changes->conferenceProvider);
        }
        // The occurrences moved: their notes go along to the new keys.
        $notes = null === $moved ? [] : $this->notes->lift($object, static fn (string $noteKey): ?string => '' === $noteKey ? null : $moved($noteKey));
        $rows = $this->store->save($object, $vcalendar, notify: $notify);
        $this->notes->put($notes, $rows);
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
            $messages = self::itip(self::broker()->parseEvent(clone $vcalendar, self::hrefs($self, $old, $vcalendar), clone $old));
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
    private function write(VEvent $event, EventChanges $changes, VCalendar $vcalendar, Calendar $calendar, bool $withRecurrence, array $self): void
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
        // After the description: the join line of a link Tresso knows is managed there.
        self::writeConference($event, self::conferenceUrlFor($event, $changes), $calendar, self::organizes($event, $self));

        self::touch($event, self::significantState($event) !== $before);
    }

    /**
     * Writes onto an override only the fields the user changed: those where the request differs from the series it
     * was opened from ($oldMaster). The others keep the override's own values, and its guests keep their answers.
     *
     * @param list<string> $self
     */
    private function writeEdits(VEvent $override, VEvent $oldMaster, EventChanges $changes, VCalendar $vcalendar, Calendar $calendar, array $self, bool $keepTime): void
    {
        $edited = clone $oldMaster;
        $this->write($edited, $changes, $vcalendar, $calendar, false, $self);
        $changed = static fn (\Closure $state): bool => $state($oldMaster) !== $state($edited);
        $text = static fn (string $name): \Closure => static fn (VEvent $event): ?string => Props::text($event, $name);
        $before = self::significantState($override);

        // The description as the series got it: with the join line of its meeting link, if any.
        foreach (['SUMMARY' => $changes->summary, 'DESCRIPTION' => self::rawText($edited, 'DESCRIPTION'), 'LOCATION' => $changes->location, 'URL' => $changes->url ?? ''] as $name => $value) {
            if ($changed($text($name))) {
                self::setText($override, $name, $value);
            }
        }
        foreach (['STATUS' => $changes->status->toICalendar(), 'TRANSP' => $changes->transparency->toICalendar(), 'CLASS' => $changes->visibility->toICalendar()] as $name => $value) {
            if ($changed($text($name))) {
                Props::set($override, $name, $value);
            }
        }
        if ($changed(self::attendeeState(...))) {
            $this->writeAttendees($override, $changes, $self);
        }
        if ($changed(self::reminderState(...))) {
            self::writeReminders($override, $changes);
        }
        if ($changed($text(EventReader::TRAVEL))) {
            self::writeTravel($override, $changes->travelMinutes);
        }
        if ($changed($text('PRIORITY'))) {
            self::writeImportance($override, $changes->important);
        }
        if ($changed(static fn (VEvent $event): ?string => ConferenceDetector::detect($event)['url'] ?? null)) {
            self::writeConference($override, self::conferenceUrlFor($override, $changes), $calendar, self::organizes($override, $self));
        }
        if (!$keepTime) {
            $override->remove('DURATION');
            self::setTime($override, 'DTSTART', $changes->start, $vcalendar);
            self::setTime($override, 'DTEND', $changes->end, $vcalendar);
        }

        self::touch($override, self::significantState($override) !== $before);
    }

    /**
     * Whether an override shows what its series' occurrence would: every property apart from those that place it
     * (its times, its recurrence id) or stamp a version, the guests with their answers, the alarms and the length.
     * Properties a provider wrote that Tresso does not model count too, so nothing is lost by dropping it.
     */
    private static function sameAsSeries(VEvent $override, VEvent $master): bool
    {
        $placing = ['DTSTART', 'DTEND', 'DURATION', 'RECURRENCE-ID', 'RRULE', 'RDATE', 'EXDATE', 'EXRULE', 'DTSTAMP', 'LAST-MODIFIED', 'CREATED', 'SEQUENCE', 'ATTENDEE'];
        $properties = static function (VEvent $event) use ($placing): array {
            $state = [];
            foreach ($event->children() as $child) {
                if ($child instanceof Property && !\in_array(strtoupper($child->name), $placing, true)) {
                    $state[] = $child->serialize();
                }
            }
            sort($state);

            return $state;
        };
        $answers = static function (VEvent $event): array {
            $state = array_map(static fn (Property $attendee): string => Props::address(Props::value($attendee)).'|'.strtoupper(Props::param($attendee, 'PARTSTAT') ?? 'NEEDS-ACTION'), Props::all($event, 'ATTENDEE'));
            sort($state);

            return $state;
        };
        $utc = new \DateTimeZone('UTC');
        $length = static fn (VEvent $event): int => Occurrences::endOf($event, $utc)->getTimestamp() - \DateTimeImmutable::createFromInterface(self::dtStart($event)->getDateTime($utc))->getTimestamp();

        return $properties($override) === $properties($master)
            && self::attendeeState($override) === self::attendeeState($master)
            && $answers($override) === $answers($master)
            && self::reminderState($override) === self::reminderState($master)
            && $length($override) === $length($master);
    }

    /** @return list<string> who is invited, by name and role, and who organizes */
    private static function attendeeState(VEvent $event): array
    {
        $state = array_map(
            static fn (Property $attendee): string => implode('|', [Props::address(Props::value($attendee)), Props::param($attendee, 'CN') ?? '', strtoupper(Props::param($attendee, 'ROLE') ?? 'REQ-PARTICIPANT')]),
            Props::all($event, 'ATTENDEE'),
        );
        sort($state);
        $organizer = Props::get($event, 'ORGANIZER');
        $state[] = null === $organizer ? '' : Props::address(Props::value($organizer));

        return $state;
    }

    /** @return list<string> the alarms, by what makes them ring (not their text), and whether the defaults apply */
    private static function reminderState(VEvent $event): array
    {
        $state = [];
        foreach (Props::components($event, 'VALARM') as $alarm) {
            $trigger = Props::get($alarm, 'TRIGGER');
            $state[] = implode('|', [
                Props::text($alarm, 'ACTION') ?? '',
                null === $trigger ? '' : Props::value($trigger),
                null === $trigger ? '' : (Props::param($trigger, 'RELATED') ?? ''),
                Props::text($alarm, EventReader::CHANNELS) ?? '',
            ]);
        }
        sort($state);
        $state[] = Props::text($event, EventReader::DEFAULT_REMINDERS) ?? '';

        return $state;
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
     * provider's version, with the join link and without this request, then replaces the stored one. The request is
     * kept on the object (the provider's version drops the properties) until the meeting is there or the worker
     * reports that it could not be made.
     *
     * Asking again changes nothing while the event has a meeting or the same request is younger than
     * {@see self::CONFERENCE_PENDING_SECONDS}; otherwise it is a new request with a new nonce. No provider (the user
     * switched the link off, or chose a link of their own) drops a request that has no meeting yet.
     */
    private function requestConference(CalendarObject $object, VCalendar $vcalendar, Calendar $calendar, ?string $provider): void
    {
        $master = CalendarDocument::master($vcalendar);
        if (null === $master) {
            return;
        }
        $request = $object->getConferenceRequest();
        if (null === $provider) {
            if (null === ConferenceDetector::detect($master)) {
                $object->setConferenceRequest(null);
                self::dropConferenceRequest($master);
            }

            return;
        }
        if (!\in_array($provider, $calendar->getConferenceProviders(), true)) {
            throw new EditRejected(\sprintf('This calendar cannot make %s meetings.', 'meet' === $provider ? 'Google Meet' : 'Microsoft Teams'));
        }
        if (null !== ConferenceDetector::detect($master)) {
            return;
        }
        $now = $this->clock->now();
        if (null !== $request && 'pending' === $request['status'] && $provider === $request['provider']
            && new \DateTimeImmutable($request['requestedAt']) > $now->modify(\sprintf('-%d seconds', self::CONFERENCE_PENDING_SECONDS))) {
            // Still on its way: the same request, so a write that is retried asks the provider for the same meeting
            // (written again only when the provider's version has dropped it, so asking again changes nothing).
            if ($provider !== Props::text($master, self::CONFERENCE_REQUEST) || $request['nonce'] !== Props::text($master, self::CONFERENCE_NONCE)) {
                Props::set($master, self::CONFERENCE_REQUEST, $provider);
                Props::set($master, self::CONFERENCE_NONCE, $request['nonce']);
            }
            $master->remove(self::CONFERENCE_REMOVE);

            return;
        }
        $nonce = bin2hex(random_bytes(4));
        $object->setConferenceRequest([
            'provider' => $provider,
            'status' => 'pending',
            'reason' => null,
            'requestedAt' => $now->setTimezone(new \DateTimeZone('UTC'))->format(\DATE_ATOM),
            'nonce' => $nonce,
        ]);
        Props::set($master, self::CONFERENCE_REQUEST, $provider);
        Props::set($master, self::CONFERENCE_NONCE, $nonce);
        $master->remove(self::CONFERENCE_REMOVE);
    }

    private static function dropConferenceRequest(VEvent $master): void
    {
        $master->remove(self::CONFERENCE_REQUEST);
        $master->remove(self::CONFERENCE_NONCE);
    }

    /**
     * Makes $url the event's meeting link (null: no meeting link). The same link as the event has changes nothing but
     * the join line's form. Another one replaces whatever made the old one: RFC 7986 CONFERENCE (also dial-in numbers),
     * Google's and Microsoft's meeting properties and the join line; the new link is written as CONFERENCE and as the
     * join line at the end of the description, which carries it through Google's and Microsoft's version.
     *
     * @throws EditRejected for a Teams meeting Microsoft made (Graph cannot take it off its event), or a link that is
     *                      not of the form a meeting link must have
     */
    private static function writeConference(VEvent $event, #[\SensitiveParameter] ?string $url, Calendar $calendar, bool $organizes): void
    {
        $description = self::rawText($event, 'DESCRIPTION');
        if ($url === (ConferenceDetector::detect($event)['url'] ?? null)) {
            // Kept: a join line the user edited or doubled is put right, on an event the user organizes whose link is
            // Tresso's (not one Google or Microsoft made, whose descriptions are theirs). Anything else is left as it is:
            // a guest's copy may not change the description at all (Google refuses the whole write).
            if (null !== $url && $organizes && !self::hasProviderMeeting($event) && null === MeetingLinkAddress::problem($url) && null !== MeetingJoinLine::find($description)) {
                self::setText($event, 'DESCRIPTION', MeetingJoinLine::with($description, $url, ConferenceDetector::providerOf($url)));
            }

            return;
        }
        if (!ConferenceDetector::removable($event, $calendar->getSource())) {
            throw new EditRejected(self::TEAMS_STAYS);
        }
        if (CalendarSource::Google === $calendar->getSource() && null !== Props::get($event, 'X-GOOGLE-CONFERENCE') && $organizes && null === Props::get($event, 'RECURRENCE-ID')) {
            // Google's meeting goes: the worker removes it only on this explicit word, on the master of an event the
            // user organizes (Google keeps one meeting for the whole series).
            Props::set($event, self::CONFERENCE_REMOVE, 'meet');
        }
        if (null !== $url) {
            $violation = MeetingLinkAddress::violation($url);
            if (null !== $violation) {
                throw new EditRejected($violation);
            }
        }
        foreach (['CONFERENCE', 'X-GOOGLE-CONFERENCE', 'X-MICROSOFT-SKYPETEAMSMEETINGURL', 'X-MICROSOFT-ONLINEMEETINGCONFLINK'] as $name) {
            $event->remove($name);
        }
        self::setText($event, 'DESCRIPTION', MeetingJoinLine::with($description, $url, null === $url ? 'other' : ConferenceDetector::providerOf($url)));
        if (null !== $url) {
            $event->add('CONFERENCE', $url, ['VALUE' => 'URI', 'FEATURE' => 'VIDEO']);
        }
    }

    /** A meeting Google or Microsoft made: their properties name it. */
    private static function hasProviderMeeting(VEvent $event): bool
    {
        foreach (['X-GOOGLE-CONFERENCE', 'X-MICROSOFT-SKYPETEAMSMEETINGURL', 'X-MICROSOFT-ONLINEMEETINGCONFLINK'] as $name) {
            if (null !== Props::get($event, $name)) {
                return true;
            }
        }

        return false;
    }

    /**
     * Asks the calendar's provider for a meeting on the whole series, outside an editor save: Retry after a failure, or
     * a link for a saved event. Changes nothing while the event has a meeting or the same request is still young.
     */
    public function requestMeeting(CalendarEvent $row, string $provider, bool $notify = true): CalendarEvent
    {
        $calendar = $row->getCalendar();
        self::requireOrganizer($row);
        self::requireWritable($calendar);
        $object = $this->objects->lock($row->getObject());
        $old = CalendarDocument::parse($object->getIcal());
        $vcalendar = CalendarDocument::parse($object->getIcal());
        $master = CalendarDocument::master($vcalendar) ?? throw new EditRejected('This event no longer exists.');
        $requestBefore = $object->getConferenceRequest();

        $this->requestConference($object, $vcalendar, $calendar, $provider);
        if ($object->getConferenceRequest() === $requestBefore && $vcalendar->serialize() === $old->serialize()) {
            return $this->masterRow($object, $row);
        }
        self::touch($master, false);
        $rows = $this->store->save($object, $vcalendar, notify: $notify);
        $this->schedule($calendar, $old, $vcalendar, $notify);

        return $rows[''] ?? $row;
    }

    /**
     * Takes the meeting link off the whole series, or drops a request for one that is pending or failed ("Leave
     * without a link"). Removing nothing changes nothing.
     *
     * @throws EditRejected for a Teams meeting Microsoft made: Graph cannot take it off its event
     */
    public function removeMeeting(CalendarEvent $row, bool $notify = true): CalendarEvent
    {
        $calendar = $row->getCalendar();
        self::requireOrganizer($row);
        self::requireWritable($calendar);
        $object = $this->objects->lock($row->getObject());
        $old = CalendarDocument::parse($object->getIcal());
        $vcalendar = CalendarDocument::parse($object->getIcal());
        $master = CalendarDocument::master($vcalendar) ?? throw new EditRejected('This event no longer exists.');

        // The series' link goes from every occurrence that shows it; an occurrence with a link of its own keeps that.
        $url = ConferenceDetector::detect($master)['url'] ?? null;
        // Tresso can only remove what is its or the provider's: a property or the join line, not the event's own text.
        $removable = self::hasProviderMeeting($master) || null !== Props::get($master, 'CONFERENCE') || null !== MeetingJoinLine::find(self::rawText($master, 'DESCRIPTION'));
        foreach (CalendarDocument::events($vcalendar) as $event) {
            if (null === $url || (ConferenceDetector::detect($event)['url'] ?? null) !== $url) {
                continue;
            }
            $before = self::significantState($event);
            self::writeConference($event, null, $calendar, true);
            if (self::significantState($event) !== $before || $event === $master) {
                self::touch($event, self::significantState($event) !== $before);
            }
        }
        if (null !== $url && !$removable) {
            // Found in the event's own text alone (its place, link or description): only the user can take it out there.
            // A meeting that also has its link in the text is removed; the text stays as the user wrote it.
            throw new EditRejected(self::TEXT_LINK);
        }
        $hadRequest = null !== Props::get($master, self::CONFERENCE_REQUEST) || null !== Props::get($master, self::CONFERENCE_NONCE);
        self::dropConferenceRequest($master);

        if (null === $url && !$hadRequest) {
            // Nothing in the event itself: only a request the worker reported on (failed) may be left to drop.
            if (null !== $object->getConferenceRequest()) {
                $this->store->setConferenceRequest($object, null);
            }

            return $this->masterRow($object, $row);
        }
        if (null === $url) {
            self::touch($master, false);
        }
        $object->setConferenceRequest(null);
        $rows = $this->store->save($object, $vcalendar, notify: $notify);
        $this->schedule($calendar, $old, $vcalendar, $notify);

        return $rows[''] ?? $row;
    }

    /**
     * "Leave without a link": drops the series' pending or failed request and nothing else. Unlike
     * {@see self::removeMeeting()} it never takes a link off the event, never tells the guests and never asks the
     * provider to remove a meeting: when the series has a link (it arrived after the client last looked) it refuses.
     * A request that is still in the event's text goes out of it with a write that asks for nothing; one only on the
     * object is cleared there. No request and no link changes nothing.
     *
     * @throws MeetingLinkPresent when the series has a meeting link
     */
    public function dropMeetingRequest(CalendarEvent $row): CalendarEvent
    {
        $calendar = $row->getCalendar();
        self::requireOrganizer($row);
        self::requireWritable($calendar);
        $object = $this->objects->lock($row->getObject());
        $vcalendar = CalendarDocument::parse($object->getIcal());
        $master = CalendarDocument::master($vcalendar) ?? throw new EditRejected('This event no longer exists.');
        if (null !== ConferenceDetector::detect($master)) {
            throw new MeetingLinkPresent();
        }

        if (null === Props::get($master, self::CONFERENCE_REQUEST) && null === Props::get($master, self::CONFERENCE_NONCE)) {
            if (null !== $object->getConferenceRequest()) {
                $this->store->setConferenceRequest($object, null);
            }

            return $this->masterRow($object, $row);
        }
        self::dropConferenceRequest($master);
        self::touch($master, false);
        $object->setConferenceRequest(null);
        // Nobody is told: the event did not change for its guests.
        $rows = $this->store->save($object, $vcalendar, notify: false);

        return $rows[''] ?? $row;
    }

    /**
     * The meeting link a save asks for. `conferenceUrl: null` with `conferenceProvider` X on an event that already has a
     * meeting of app X keeps that meeting: a client that wrote from a copy older than the link (made by the provider
     * after the client last looked) asks for the meeting it has, not for a second one. Removing a link takes both
     * fields null, or DELETE .../meeting-link; another app replaces it as before.
     */
    private static function conferenceUrlFor(VEvent $event, EventChanges $changes): ?string
    {
        if (null !== $changes->conferenceUrl || null === $changes->conferenceProvider) {
            return $changes->conferenceUrl;
        }
        $existing = ConferenceDetector::detect($event);

        return null !== $existing && $changes->conferenceProvider === $existing['provider'] ? $existing['url'] : null;
    }

    /** The same changes without a provider to ask: the link they name (or none) is written as given. */
    private static function withoutProvider(EventChanges $changes): EventChanges
    {
        return new EventChanges(
            $changes->summary, $changes->description, $changes->location, $changes->url, $changes->start, $changes->end, $changes->rrule,
            $changes->status, $changes->transparency, $changes->visibility, $changes->attendees, $changes->reminders, $changes->conferenceUrl,
            $changes->useDefaultReminders, $changes->travelMinutes, $changes->important,
        );
    }

    /**
     * Whether the user organizes the event: it names no organizer, or one of the user's addresses.
     *
     * @param list<string> $self
     */
    private static function organizes(VEvent $event, array $self): bool
    {
        $organizer = Props::get($event, 'ORGANIZER');

        return null === $organizer || \in_array(Props::address(Props::value($organizer)), $self, true);
    }

    /** Invited events are the organizer's: their meeting link is not the user's to change. */
    private static function requireOrganizer(CalendarEvent $row): void
    {
        if (null !== $row->getSelfPartstat()) {
            throw new EditRejected(self::ORGANIZER_ONLY);
        }
    }

    /** The master row of the resource, else the row the user acted on. */
    private function masterRow(CalendarObject $object, CalendarEvent $row): CalendarEvent
    {
        return $this->events->findForObject($object)[''] ?? $row;
    }

    /** The text of a property as stored, untrimmed; '' when it is missing. */
    private static function rawText(VEvent $event, string $name): string
    {
        $property = Props::get($event, $name);

        return null === $property ? '' : Props::value($property);
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
    private function editAll(VCalendar $vcalendar, Calendar $calendar, VEvent $master, EventChanges $changes, ?string $key, array $self): ?\Closure
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
            // A floating series that gets a zone (or a zoned one that loses it): its exceptions take the new form, or
            // their keys would no longer meet the series' (a wall clock read as UTC against an instant).
            $form = (null === $masterStart->timeZone) === (null === $changes->start->timeZone) ? null : null === $changes->start->timeZone;
            foreach ($overrides as $override) {
                $atItsTime = self::atItsOwnTime($override);
                self::shiftProperty(Props::dateTime($override, 'RECURRENCE-ID'), $shift, $masterStart->timeZone, $changes->start->timeZone, $vcalendar, $form);
                if ($atItsTime) {
                    // Changed in other ways only: it moves with the series.
                    self::shiftProperty(Props::dateTime($override, 'DTSTART'), $shift, $masterStart->timeZone, $changes->start->timeZone, $vcalendar, $form);
                    self::shiftProperty(Props::dateTime($override, 'DTEND'), $shift, $masterStart->timeZone, $changes->start->timeZone, $vcalendar, $form);
                } elseif (null !== $form) {
                    // Moved to its own time: it stays there, in the series' new form (floating or zoned), so readers in
                    // another zone see it at the same time as the rest.
                    self::shiftProperty(Props::dateTime($override, 'DTSTART'), 0, $masterStart->timeZone, $changes->start->timeZone, $vcalendar, $form);
                    self::shiftProperty(Props::dateTime($override, 'DTEND'), 0, $masterStart->timeZone, $changes->start->timeZone, $vcalendar, $form);
                }
            }
            foreach ([...Props::dateTimes($master, 'EXDATE'), ...Props::dateTimes($master, 'RDATE')] as $property) {
                self::shiftProperty($property, $shift, $masterStart->timeZone, $changes->start->timeZone, $vcalendar, $form);
            }
        }

        $this->write($master, new EventChanges(
            $changes->summary, $changes->description, $changes->location, $changes->url, $newStart, $newEnd, $rule,
            $changes->status, $changes->transparency, $changes->visibility, $changes->attendees, $changes->reminders, $changes->conferenceUrl,
            $changes->useDefaultReminders, $changes->travelMinutes, $changes->important, $changes->conferenceProvider,
        ), $vcalendar, $calendar, true, $self);

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
        $oldMaster = clone $master;
        $masterData = EventReader::read($master, $vcalendar, $self);
        $masterLength = self::wallClockSeconds($masterData->end) - self::wallClockSeconds($masterData->start);

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
        $notes = $this->notes->lift($object, static fn (string $noteKey): ?string => '' === $noteKey || $noteKey < $key ? null : ((null === $mover ? null : $mover($noteKey)) ?? $noteKey));
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
        // Without the provider: the new series is a new event at the provider, which makes a meeting of its own when
        // asked (below); keeping the old series' meeting properties would leave it with none.
        $this->write($newMaster, new EventChanges(
            $changes->summary, $changes->description, $changes->location, $changes->url, $start, $end, $rule,
            $changes->status, $changes->transparency, $changes->visibility, $changes->attendees, $changes->reminders, $changes->conferenceUrl,
            $changes->useDefaultReminders, $changes->travelMinutes, $changes->important,
        ), $next, $object->getCalendar(), true, $self);
        if (null !== $edited) {
            // The occurrence the user edited was changed before: its override replaces the new series' first
            // occurrence, so it takes the edit too, but only what the user changed. A client may send the series'
            // values for the fields left alone, which must not undo what made this occurrence its own.
            $sameLength = self::wallClockSeconds($changes->end) - self::wallClockSeconds($changes->start) === $masterLength;
            $this->writeEdits($edited, $oldMaster, self::withoutProvider($changes), $next, $object->getCalendar(), $self, 0 === $shift && $sameLength);
            if (self::atItsOwnTime($edited) && self::sameAsSeries($edited, $newMaster)) {
                // Nothing left that makes it its own: the new series' first occurrence, which a later change of the
                // series must reach.
                $next->remove($edited);
            }
        }
        self::withOrganizer($next, $object->getCalendar(), $organizer);
        $newObject = new CalendarObject($object->getCalendar(), $uid, '');
        $this->requestConference($newObject, $next, $object->getCalendar(), $changes->conferenceProvider);

        $rows = $this->store->save($newObject, $next, notify: $notify);
        $this->notes->put($notes, $rows);
        $this->schedule($object->getCalendar(), null, $next, $notify);

        return $rows[''];
    }

    /**
     * @param list<string> $self
     */
    private function move(CalendarObject $object, VCalendar $vcalendar, VCalendar $old, ?VEvent $master, EventChanges $changes, ?string $key, Calendar $target, bool $notify, array $self, ?MailAccount $organizer): CalendarEvent
    {
        // A meeting of the source's account stays only within that account: the new calendar's provider makes its own
        // (so the guard that keeps a meeting a save asks for again does not hold across accounts).
        $written = $object->getCalendar()->getMailAccount() === $target->getMailAccount() ? $changes : self::withoutProvider($changes);
        $moved = null;
        if (null !== $master) {
            if (null === $key) {
                $this->write($master, $written, $vcalendar, $object->getCalendar(), true, $self);
            } else {
                $moved = $this->editAll($vcalendar, $object->getCalendar(), $master, $written, $key, $self);
            }
        } elseif (null !== $key) {
            // The occurrence the user opened takes the edit, as it would without the move.
            $this->write($this->occurrence($vcalendar, null, $key), $written, $vcalendar, $object->getCalendar(), false, $self);
        }
        if (null !== $this->objects->findOneByUid($target, $object->getUid())) {
            throw new EditRejected('The other calendar already has this event.');
        }
        self::refuseOrganizerChange($object->getCalendar(), $target, $vcalendar);
        self::withOrganizer($vcalendar, $target, $organizer);
        $movedObject = new CalendarObject($target, $object->getUid(), '');
        $this->requestConference($movedObject, $vcalendar, $target, $changes->conferenceProvider);
        // What only the old calendar's provider could act on does not go along: the word to remove Google's meeting, and
        // a request the new calendar cannot serve.
        $movedMaster = CalendarDocument::master($vcalendar);
        if (null !== $movedMaster) {
            if (CalendarSource::Google !== $target->getSource()) {
                $movedMaster->remove(self::CONFERENCE_REMOVE);
            }
            $asked = Props::text($movedMaster, self::CONFERENCE_REQUEST);
            if (null !== $asked && !\in_array($asked, $target->getConferenceProviders(), true)) {
                self::dropConferenceRequest($movedMaster);
                $movedObject->setConferenceRequest(null);
            }
        }
        $source = $object->getCalendar();
        // Every note goes along to the new resource (removing the old one would delete them).
        $notes = $this->notes->lift($object, static fn (string $noteKey): string => '' === $noteKey ? '' : ((null === $moved ? null : $moved($noteKey)) ?? $noteKey));
        $this->store->remove($object, notify: $notify && $source->getMailAccount() !== $target->getMailAccount());
        $rows = $this->store->save($movedObject, $vcalendar, notify: $notify);
        $this->notes->put($notes, $rows);
        $this->schedule($source, $old, null, $notify && $source->getMailAccount() !== $target->getMailAccount());
        $this->schedule($target, $source->getMailAccount() === $target->getMailAccount() ? $old : null, $vcalendar, $notify);

        return $rows[$key ?? ''] ?? $rows[''] ?? array_values($rows)[0];
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
        $messages = self::itip(self::broker()->parseEvent(null === $new ? null : clone $new, self::hrefs($self, $old, $new), null === $old ? null : clone $old));
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
    private static function shiftProperty(?DateTimeProperty $property, int $seconds, ?string $from, ?string $zone, VCalendar $vcalendar, ?bool $toFloating = null): void
    {
        if (null === $property) {
            return;
        }
        $zoned = $property->hasTime() && !$property->isFloating();
        $utc = $zoned && null === Props::param($property, 'TZID');
        // The form it ends in: its own, unless the series changes between floating and zoned (then it follows).
        $floating = $toFloating ?? !$zoned;
        $values = [];
        foreach ($property->getDateTimes(new \DateTimeZone('UTC')) as $value) {
            if ($utc && null !== $from) {
                $value = \DateTimeImmutable::createFromInterface($value)->setTimezone(new \DateTimeZone($from));
            }
            $wallClock = new \DateTimeImmutable($value->format('Y-m-d H:i:s'), new \DateTimeZone('UTC'))->modify(\sprintf('%+d seconds', $seconds));
            $shifted = !$floating && null !== ($zone ?? $from)
                ? new \DateTimeImmutable($wallClock->format('Y-m-d H:i:s'), new \DateTimeZone($zone ?? $from))
                : $wallClock;
            $values[] = $utc && !$floating ? $shifted->setTimezone(new \DateTimeZone('UTC')) : $shifted;
        }
        if (!$property->hasTime()) {
            $property->setDateTimes($values);
            $property['VALUE'] = 'DATE';

            return;
        }
        $property->setDateTimes($values, $floating);
        if (!$utc && null !== $zone && !$floating && 'UTC' !== $zone) {
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
     * The user's addresses as sabre's broker compares them: it takes each ORGANIZER and ATTENDEE as sabre normalizes
     * it (the scheme and, for mailto, the address in ASCII lower case), so a capital outside ASCII stays. Every
     * spelling of the user's addresses in the objects is given as sabre reads it, found by the one comparison Tresso
     * uses everywhere ({@see Props::address()}).
     *
     * @param list<string> $addresses lower case
     *
     * @return list<string>
     */
    private static function hrefs(array $addresses, ?VCalendar ...$calendars): array
    {
        $hrefs = array_map(static fn (string $address): string => 'mailto:'.$address, $addresses);
        foreach ($calendars as $calendar) {
            foreach (null === $calendar ? [] : CalendarDocument::events($calendar) as $event) {
                foreach ([...Props::all($event, 'ORGANIZER'), ...Props::all($event, 'ATTENDEE')] as $property) {
                    if ($property instanceof CalAddress && \in_array(Props::address(Props::value($property)), $addresses, true)) {
                        $hrefs[] = $property->getNormalizedValue();
                    }
                }
            }
        }

        return array_values(array_unique($hrefs));
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
