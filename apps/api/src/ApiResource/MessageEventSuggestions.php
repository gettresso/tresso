<?php

declare(strict_types=1);

namespace App\ApiResource;

use ApiPlatform\Metadata\ApiProperty;
use ApiPlatform\Metadata\ApiResource;
use ApiPlatform\Metadata\Get;
use App\Calendar\Assistant\ExtractedDeadline;
use App\Calendar\Assistant\ExtractedEvent;
use App\Security\Scope;
use App\State\MessageEventSuggestionsProvider;

/**
 * Events and deadlines found in a message, to offer next to it: "Add to calendar" for an event (or "Open" when the
 * user's calendar has it, `eventId`), "Make todo" for a deadline. Each event is a draft in the editor's shape; nothing
 * is saved. The built-in extractor finds the events of the message's text/calendar parts and no deadlines;
 * `GET /api/v1/calendar/capabilities` says whether the text is read too.
 */
#[ApiResource(
    shortName: 'MessageEventSuggestions',
    routePrefix: '/api/v1',
    normalizationContext: ['skip_null_values' => false],
    operations: [
        new Get(
            uriTemplate: '/messages/{id}/event-suggestions',
            security: "is_granted('".Scope::ROLE_MAIL_READ."') and is_granted('".Scope::ROLE_CALENDAR_READ."')",
            provider: MessageEventSuggestionsProvider::class,
        ),
    ],
)]
final readonly class MessageEventSuggestions
{
    /**
     * @param list<ExtractedEvent>    $events
     * @param list<ExtractedDeadline> $deadlines
     */
    public function __construct(
        #[ApiProperty(identifier: true)]
        public string $id,
        public array $events,
        public array $deadlines,
    ) {
    }
}
