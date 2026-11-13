<?php

declare(strict_types=1);

namespace App\ApiResource;

use ApiPlatform\Metadata\ApiResource;
use ApiPlatform\Metadata\Get;
use App\Security\Scope;
use App\State\CalendarCapabilitiesProvider;

/**
 * Which calendar assistant features, and which newer calendar operations, this server offers, so clients show only
 * what works.
 */
#[ApiResource(
    shortName: 'CalendarCapabilities',
    routePrefix: '/api/v1',
    operations: [
        new Get(
            uriTemplate: '/calendar/capabilities',
            uriVariables: [],
            security: "is_granted('".Scope::ROLE_CALENDAR_READ."')",
            provider: CalendarCapabilitiesProvider::class,
        ),
    ],
)]
final readonly class CalendarCapabilities
{
    public function __construct(
        /** `POST /api/v1/calendar/event-drafts` reads free text into an event. */
        public bool $eventDrafts,
        /** `POST /api/v1/calendar/meeting-times` proposes times (always). */
        public bool $meetingTimes,
        /** Meeting times know attendees' busy time. */
        public bool $attendeeAvailability,
        /** `GET /api/v1/messages/{id}/event-suggestions` finds events in a message's calendar parts (always). */
        public bool $eventSuggestions,
        /** Event suggestions also come from the message's text, with deadlines. */
        public bool $textSuggestions,
        /** `GET /api/v1/calendar-events/{id}/brief` gathers a brief from mail metadata (always). */
        public bool $meetingBriefs,
        /** Briefs carry a written summary. */
        public bool $briefSummaries,
        /**
         * `DELETE /api/v1/calendar-events/{id}/meeting-link/request` drops only a meeting request (always on this
         * server). Without it a client hides "Leave without a link": an older server has only the DELETE that removes
         * the link.
         */
        public bool $meetingRequestDrop,
    ) {
    }
}
