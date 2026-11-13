<?php

declare(strict_types=1);

namespace App\Calendar\ICalendar;

use App\Enum\EventStatus;
use App\Enum\EventVisibility;
use App\Enum\ParticipationStatus;
use App\Enum\Transparency;

/**
 * One VEVENT, read from iCalendar into the fields Tresso stores and serves.
 *
 * @phpstan-type Address array{address: string, name: ?string}
 * @phpstan-type Attendee array{address: string, name: ?string, role: string, partstat: string, rsvp: bool, kind: string}
 * @phpstan-type Reminder array{action: string, trigger: ?string, relatedTo: string, at: ?string, channels: list<string>}
 * @phpstan-type Conference array{provider: string, url: string, id: ?string, dialIn: ?string, removable?: bool}
 */
final readonly class EventData
{
    /**
     * @param list<string>     $rdates    recurrence keys of extra occurrences
     * @param list<string>     $exdates   recurrence keys of removed occurrences
     * @param Address|null     $organizer
     * @param list<Attendee>   $attendees
     * @param list<Reminder>   $reminders
     * @param Conference|null  $conference
     */
    public function __construct(
        public string $uid,
        /** '' for a master or single event, else the {@see RecurrenceKey} of the overridden occurrence. */
        public string $recurrenceKey,
        public int $sequence,
        public EventStatus $status,
        public string $summary,
        public string $description,
        public string $location,
        public ?string $url,
        public Transparency $transparency,
        public EventVisibility $visibility,
        public EventTime $start,
        public EventTime $end,
        public \DateTimeImmutable $startsAt,
        public \DateTimeImmutable $endsAt,
        public ?string $rrule,
        public array $rdates,
        public array $exdates,
        /** End of the last occurrence; null when the series never ends. */
        public ?\DateTimeImmutable $seriesEndsAt,
        public ?array $organizer,
        public array $attendees,
        public ?ParticipationStatus $selfPartstat,
        public array $reminders,
        public ?array $conference,
        /** Minutes to travel to the event, set by the user; null when unknown. */
        public ?int $travelMinutes = null,
        /** The event has no reminders of its own, so the user's default rules apply. */
        public bool $defaultReminders = true,
        /** A high priority: reminders reach the user also in quiet and outside working hours. */
        public bool $important = false,
        /** An override with RANGE=THISANDFUTURE: it changes every later occurrence of the series too. */
        public bool $thisAndFuture = false,
    ) {
    }

    public function isAllDay(): bool
    {
        return $this->start->isDate;
    }
}
