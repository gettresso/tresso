<?php

declare(strict_types=1);

namespace App\ApiResource;

use ApiPlatform\Metadata\ApiProperty;
use ApiPlatform\Metadata\ApiResource;
use ApiPlatform\Metadata\GetCollection;
use ApiPlatform\Metadata\QueryParameter;
use App\Calendar\ICalendar\EventData;
use App\Entity\CalendarEvent;
use App\Security\Scope;
use App\State\CalendarOccurrenceProvider;
use Symfony\Component\Validator\Constraints as Assert;

/**
 * One occurrence of an event in a time range, with recurrence expanded, overrides applied and exceptions left out.
 * Timed occurrences carry instants (UTC); all-day occurrences carry dates, read in `timeZone`. Edit through the
 * event (`eventId`) with this occurrence's `recurrenceId`.
 *
 * @phpstan-import-type Address from EventData
 * @phpstan-import-type Conference from EventData
 * @phpstan-import-type PublicConferenceRequest from CalendarEvent
 */
#[ApiResource(
    shortName: 'CalendarOccurrence',
    routePrefix: '/api/v1',
    normalizationContext: ['skip_null_values' => false],
    operations: [
        new GetCollection(
            uriTemplate: '/calendar-occurrences',
            paginationEnabled: false,
            security: "is_granted('".Scope::ROLE_CALENDAR_READ."')",
            provider: CalendarOccurrenceProvider::class,
            parameters: [
                'from' => new QueryParameter(
                    schema: ['type' => 'string', 'format' => 'date-time'],
                    description: 'Start of the range (inclusive).',
                    required: true,
                    constraints: [new Assert\NotBlank(), new Assert\DateTime(format: \DATE_ATOM)],
                ),
                'to' => new QueryParameter(
                    schema: ['type' => 'string', 'format' => 'date-time'],
                    description: 'End of the range (exclusive), at most 400 days after from.',
                    required: true,
                    constraints: [new Assert\NotBlank(), new Assert\DateTime(format: \DATE_ATOM)],
                ),
                'timeZone' => new QueryParameter(
                    schema: ['type' => 'string', 'default' => 'UTC'],
                    description: 'The reader\'s IANA time zone, for all-day and floating events.',
                    constraints: [new Assert\Timezone()],
                ),
                'calendarId[]' => new QueryParameter(
                    schema: ['type' => 'array', 'items' => ['type' => 'string', 'format' => 'uuid']],
                    description: 'Only these calendars; all when omitted.',
                    constraints: [new Assert\All([new Assert\Uuid()])],
                ),
            ],
        ),
    ],
)]
final readonly class CalendarOccurrence
{
    /**
     * @param array{date: string}|array{dateTime: string} $start
     * @param array{date: string}|array{dateTime: string} $end
     * @param Address|null                                $organizer
     * @param Conference|null                             $conference
     * @param PublicConferenceRequest|null                $conferenceRequest the series' meeting link request (none on a
     *                                                                       changed occurrence)
     */
    public function __construct(
        #[ApiProperty(identifier: true)]
        public string $id,
        public string $eventId,
        public string $calendarId,
        public ?string $recurrenceId,
        public bool $recurring,
        public bool $allDay,
        public array $start,
        public array $end,
        public ?string $timeZone,
        public string $status,
        public string $summary,
        public string $location,
        public string $transparency,
        public string $visibility,
        public ?array $organizer,
        public int $attendeeCount,
        public ?string $selfResponse,
        public ?array $conference,
        public ?array $conferenceRequest,
    ) {
    }
}
