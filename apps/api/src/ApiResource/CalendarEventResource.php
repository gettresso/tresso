<?php

declare(strict_types=1);

namespace App\ApiResource;

use ApiPlatform\Metadata\ApiProperty;
use ApiPlatform\Metadata\ApiResource;
use ApiPlatform\Metadata\Delete;
use ApiPlatform\Metadata\Get;
use ApiPlatform\Metadata\Post;
use ApiPlatform\Metadata\Put;
use ApiPlatform\Metadata\QueryParameter;
use App\ApiResource\Input\Calendar\EventInput;
use App\ApiResource\Input\Calendar\EventResponseInput;
use App\ApiResource\Input\Calendar\MeetingLinkInput;
use App\Calendar\ICalendar\EventData;
use App\Entity\CalendarEvent;
use App\Security\Scope;
use App\State\CalendarEventProcessor;
use App\State\CalendarEventProvider;
use App\State\MeetingLinkProcessor;
use Symfony\Component\Validator\Constraints as Assert;

/**
 * An event as stored: a single event, the master of a recurring series (with its `recurrence` rule, extra
 * `rdates` and removed `exdates`), or an override of one occurrence (`recurrenceId` set). Occurrences of series in a
 * time range come from /calendar-occurrences.
 *
 * Changes to recurring events take `scope` (this, following or all) and the `recurrenceId` of the occurrence the
 * user acted on. `notify=false` keeps invitations, updates and cancellations from being sent.
 *
 * `conferenceRequest` is a meeting link asked of the calendar's provider (`conferenceProvider` on a save, or
 * `POST /calendar-events/{id}/meeting-link`) that is not on the event yet: `pending`, or `failed` with a reason
 * (`refused`, `not_supported`, `unreachable`). `DELETE /calendar-events/{id}/meeting-link` takes the link off the
 * series or drops the request. Both act on the whole series and only for events the user organizes. A save that
 * sends the provider of a request that is still pending changes nothing about it; one that sends the provider of a
 * failed request asks again. `conference.provider` and `conferenceRequest.provider` are plain strings (`other` for a
 * link of no known app): a client shows a name it does not know as a meeting link. `conference.removable` is false
 * for a Teams meeting Microsoft made on its calendar's event, which cannot be taken off it (rows stored before the
 * field existed lack it until the event changes).
 *
 * A save replaces the meeting link with `conferenceUrl`: a client that keeps the link sends `conference.url` back as
 * it got it. Without it the link is removed (and a Microsoft event with a Teams meeting answers 422). A client must
 * not send `conferenceUrl: null` from a copy that may predate the link (it would remove a link made since); it sends
 * null only when the user removed the link in that client.
 *
 * @phpstan-import-type Address from EventData
 * @phpstan-import-type Attendee from EventData
 * @phpstan-import-type Reminder from EventData
 * @phpstan-import-type Conference from EventData
 * @phpstan-import-type PublicConferenceRequest from CalendarEvent
 */
#[ApiResource(
    shortName: 'CalendarEvent',
    routePrefix: '/api/v1',
    normalizationContext: ['skip_null_values' => false],
    operations: [
        new Get(
            uriTemplate: '/calendar-events/{id}',
            security: "is_granted('".Scope::ROLE_CALENDAR_READ."')",
            provider: CalendarEventProvider::class,
        ),
        new Post(
            uriTemplate: '/calendar-events',
            security: "is_granted('".Scope::ROLE_CALENDAR_WRITE."')",
            input: EventInput::class,
            read: false,
            processor: CalendarEventProcessor::class,
            parameters: ['notify' => new QueryParameter(schema: ['type' => 'boolean', 'default' => true], description: 'Send invitations to attendees.', constraints: [new Assert\Regex('/^(true|false|1|0)?$/')])],
        ),
        new Put(
            uriTemplate: '/calendar-events/{id}',
            security: "is_granted('".Scope::ROLE_CALENDAR_WRITE."')",
            input: EventInput::class,
            provider: CalendarEventProvider::class,
            processor: CalendarEventProcessor::class,
            allowCreate: false,
            parameters: [
                'scope' => new QueryParameter(
                    schema: ['type' => 'string', 'enum' => ['this', 'following', 'all']],
                    description: 'For recurring events: this occurrence, this and following, or all occurrences. Without it, "this" for a changed occurrence (an override) and "all" for anything else.',
                    constraints: [new Assert\Choice(choices: ['this', 'following', 'all'])],
                ),
                'recurrenceId' => new QueryParameter(
                    schema: ['type' => 'string', 'pattern' => '^\d{8}(T\d{6}Z)?$'],
                    description: 'The occurrence the user acted on (its recurrenceId from /calendar-occurrences).',
                    constraints: [new Assert\Regex('/^\d{8}(T\d{6}Z)?$/')],
                ),
                'notify' => new QueryParameter(
                    schema: ['type' => 'boolean', 'default' => true],
                    description: 'Send updates or cancellations to attendees.',
                    constraints: [new Assert\Regex('/^(true|false|1|0)?$/')],
                ),
            ],
        ),
        new Delete(
            uriTemplate: '/calendar-events/{id}',
            security: "is_granted('".Scope::ROLE_CALENDAR_WRITE."')",
            provider: CalendarEventProvider::class,
            processor: CalendarEventProcessor::class,
            parameters: [
                'scope' => new QueryParameter(
                    schema: ['type' => 'string', 'enum' => ['this', 'following', 'all']],
                    description: 'For recurring events: this occurrence, this and following, or all occurrences. Without it, "this" for a changed occurrence (an override) and "all" for anything else.',
                    constraints: [new Assert\Choice(choices: ['this', 'following', 'all'])],
                ),
                'recurrenceId' => new QueryParameter(
                    schema: ['type' => 'string', 'pattern' => '^\d{8}(T\d{6}Z)?$'],
                    description: 'The occurrence the user acted on (its recurrenceId from /calendar-occurrences).',
                    constraints: [new Assert\Regex('/^\d{8}(T\d{6}Z)?$/')],
                ),
                'notify' => new QueryParameter(
                    schema: ['type' => 'boolean', 'default' => true],
                    description: 'Send updates or cancellations to attendees.',
                    constraints: [new Assert\Regex('/^(true|false|1|0)?$/')],
                ),
            ],
        ),
        new Post(
            uriTemplate: '/calendar-events/{id}/response',
            status: 200,
            security: "is_granted('".Scope::ROLE_CALENDAR_WRITE."')",
            input: EventResponseInput::class,
            provider: CalendarEventProvider::class,
            processor: CalendarEventProcessor::class,
            name: 'calendar_event_response',
        ),
        new Post(
            uriTemplate: '/calendar-events/{id}/meeting-link',
            status: 200,
            security: "is_granted('".Scope::ROLE_CALENDAR_WRITE."')",
            input: MeetingLinkInput::class,
            provider: CalendarEventProvider::class,
            processor: MeetingLinkProcessor::class,
            name: 'calendar_event_meeting_link',
            parameters: ['notify' => new QueryParameter(schema: ['type' => 'boolean', 'default' => true], description: 'Send updates to attendees.', constraints: [new Assert\Regex('/^(true|false|1|0)?$/')])],
        ),
        new Delete(
            uriTemplate: '/calendar-events/{id}/meeting-link',
            status: 200,
            security: "is_granted('".Scope::ROLE_CALENDAR_WRITE."')",
            output: CalendarEventResource::class,
            provider: CalendarEventProvider::class,
            processor: MeetingLinkProcessor::class,
            name: 'calendar_event_meeting_link_remove',
            parameters: ['notify' => new QueryParameter(schema: ['type' => 'boolean', 'default' => true], description: 'Send updates to attendees.', constraints: [new Assert\Regex('/^(true|false|1|0)?$/')])],
        ),
    ],
)]
final readonly class CalendarEventResource
{
    /**
     * @param array{date: string}|array{dateTime: string, timeZone: ?string} $start
     * @param array{date: string}|array{dateTime: string, timeZone: ?string} $end
     * @param list<string>                                                   $rdates
     * @param list<string>                                                   $exdates
     * @param Address|null                                                   $organizer
     * @param list<Attendee>                                                 $attendees
     * @param list<Reminder>                                                 $reminders
     * @param Conference|null                                                $conference
     * @param PublicConferenceRequest|null                                   $conferenceRequest a meeting link asked of
     *                                                                                          the provider and not on
     *                                                                                          the event (yet); master
     *                                                                                          rows only
     */
    public function __construct(
        #[ApiProperty(identifier: true)]
        public string $id,
        public string $calendarId,
        public string $uid,
        public ?string $recurrenceId,
        public int $sequence,
        public string $status,
        public string $summary,
        public string $description,
        public string $location,
        public ?string $url,
        public string $transparency,
        public string $visibility,
        public bool $allDay,
        public array $start,
        public array $end,
        public ?string $recurrence,
        public array $rdates,
        public array $exdates,
        public ?array $organizer,
        public array $attendees,
        public ?string $selfResponse,
        public array $reminders,
        public ?array $conference,
        public ?array $conferenceRequest,
        public ?string $messageId,
        public ?string $syncError,
        public ?int $travelMinutes,
        public bool $defaultReminders,
        public bool $important,
        /** An override with RANGE=THISANDFUTURE: it changes every later occurrence of the series too. */
        public bool $thisAndFuture,
    ) {
    }

    public static function fromEntity(CalendarEvent $event): self
    {
        return new self(
            $event->getId()->toRfc4122(),
            $event->getCalendar()->getId()->toRfc4122(),
            $event->getUid(),
            '' === $event->getRecurrenceKey() ? null : $event->getRecurrenceKey(),
            $event->getSequence(),
            $event->getStatus()->value,
            $event->getSummary(),
            $event->getDescription(),
            $event->getLocation(),
            $event->getUrl(),
            $event->getTransparency()->value,
            $event->getVisibility()->value,
            $event->isAllDay(),
            $event->getStart()->toArray(),
            $event->getEnd()->toArray(),
            $event->getRrule(),
            $event->getRdates(),
            $event->getExdates(),
            $event->getOrganizer(),
            $event->getAttendees(),
            $event->getSelfPartstat()?->value,
            $event->getReminders(),
            $event->getConference(),
            $event->getConferenceRequest(),
            $event->getMessage()?->getId()->toRfc4122(),
            $event->getSyncError(),
            $event->getTravelMinutes(),
            $event->usesDefaultReminders(),
            $event->isImportant(),
            $event->changesTheFuture(),
        );
    }
}
