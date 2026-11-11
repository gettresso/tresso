<?php

declare(strict_types=1);

namespace App\ApiResource\Input\Calendar;

use App\Entity\Calendar;
use App\Enum\EventStatus;
use App\Enum\EventVisibility;
use App\Enum\Transparency;
use Symfony\Component\Validator\Constraints as Assert;

/**
 * An event as the editor saves it: always complete. On update, calendarId moves the event to another calendar.
 */
final class EventInput
{
    #[Assert\NotBlank]
    #[Assert\Uuid]
    public string $calendarId = '';

    #[Assert\Length(max: 1000)]
    public string $summary = '';

    #[Assert\Length(max: 100000)]
    public string $description = '';

    #[Assert\Length(max: 1000)]
    public string $location = '';

    #[Assert\Url(requireTld: true)]
    #[Assert\Length(max: 2048)]
    public ?string $url = null;

    /**
     * {"date": "2026-10-19"} for all-day events, else {"dateTime": "2026-10-19T09:00:00", "timeZone": "Europe/Amsterdam"};
     * timeZone null means floating (the same clock time everywhere).
     *
     * @var array<string, mixed>
     */
    #[Assert\NotNull]
    public array $start = [];

    /**
     * Exclusive for all-day events, as in iCalendar: a one-day event on the 19th ends on the 20th.
     *
     * @var array<string, mixed>
     */
    #[Assert\NotNull]
    public array $end = [];

    /**
     * An iCalendar RRULE value, e.g. FREQ=WEEKLY;BYDAY=MO,WE;UNTIL=20261231T230000Z. Parts in any order and parts of
     * other clients (X-..., RSCALE) are taken here, so a stored rule can be sent back as it is; a new rule must be one
     * the server can expand (checked when it is saved).
     */
    #[Assert\Length(max: 500)]
    #[Assert\Regex('/^(?=(?:.*;)?FREQ=(HOURLY|DAILY|WEEKLY|MONTHLY|YEARLY)(;|$))[A-Z][A-Z-]*=[A-Z0-9,+\-]+(;[A-Z][A-Z-]*=[A-Z0-9,+\-]+)*$/', message: 'recurrence must be an iCalendar RRULE value with FREQ (hourly or less often).')]
    public ?string $recurrence = null;

    public EventStatus $status = EventStatus::Confirmed;

    public Transparency $transparency = Transparency::Busy;

    public EventVisibility $visibility = EventVisibility::Public;

    /** @var list<AttendeeInput> */
    #[Assert\Count(max: 500)]
    #[Assert\Valid]
    public array $attendees = [];

    /** The user's default reminder rules apply; when false, exactly `reminders` (possibly none). */
    public bool $useDefaultReminders = true;

    /** @var list<ReminderInput> */
    #[Assert\Count(max: 10)]
    #[Assert\Valid]
    public array $reminders = [];

    /** Its reminders reach the user also in quiet and outside working hours. */
    public bool $important = false;

    /** Minutes to travel there, for leave-now reminders; estimated from the phone's position when null. */
    #[Assert\Range(min: 0, max: 1440)]
    public ?int $travelMinutes = null;

    #[Assert\Url(protocols: ['https'], requireTld: true)]
    #[Assert\Length(max: 2048)]
    public ?string $conferenceUrl = null;

    /**
     * Ask the calendar's provider for an online meeting: "meet" (Google calendars) or "teams" (Microsoft calendars
     * with Teams), as the calendar's conferenceProviders offer. The provider adds the join link when it saves the event.
     */
    #[Assert\Choice(choices: Calendar::CONFERENCE_PROVIDERS)]
    public ?string $conferenceProvider = null;

    /** The account that sends invitations, for events with attendees in a calendar that has no account (Tresso). */
    #[Assert\Uuid]
    public ?string $organizerMailAccountId = null;
}
