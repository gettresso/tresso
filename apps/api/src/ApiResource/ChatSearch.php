<?php

declare(strict_types=1);

namespace App\ApiResource;

use ApiPlatform\Metadata\ApiResource;
use ApiPlatform\Metadata\Get;
use App\Chat\ChatReader;
use App\Security\ChatAccessVoter;
use App\State\ChatReadProvider;

/**
 * Searches the user's WhatsApp messages on the server: `q` (2 to 200 characters, matched anywhere in a message's
 * text, file name or sender name, ignoring case), `days` (how far back, 1 to 90, default 30), `chatId` (only this
 * chat), `limit` (results, 1 to 50, default 20) and `cursor` (the `nextCursor` of the call before).
 *
 * Chat text is sealed at rest and never indexed, so each message is opened to be compared: a call opens at most
 * {@see ChatReader::SEARCH_SCAN} messages, newest first. `scanned` says how many it opened and `searchedThrough` the
 * time of the oldest; when `complete` is false the window was not searched to its start, and `nextCursor` goes on from
 * there. Searches are limited per user (`chat_search`, 429 above it). Chats the user left out are not searched. Each
 * result is a message as the delta's `chatMessages` has it, with its chat's `chatName` and `chatKind`. Needs
 * {@see ChatAccessVoter::READ}.
 */
#[ApiResource(
    shortName: 'ChatSearch',
    routePrefix: '/api/v1',
    normalizationContext: ['skip_null_values' => false],
    operations: [
        new Get(
            uriTemplate: '/chat-messages/search',
            uriVariables: [],
            security: "is_granted('".ChatAccessVoter::READ."')",
            provider: ChatReadProvider::class,
            name: ChatReadProvider::SEARCH,
        ),
    ],
)]
final readonly class ChatSearch
{
    /**
     * @param list<array<string, mixed>> $items
     */
    public function __construct(
        public array $items,
        public string $query,
        /** The start of the window searched. */
        public string $from,
        /** Messages opened by this call. */
        public int $scanned,
        /** The most a call opens. */
        public int $scanLimit,
        /** The time of the oldest message opened; null when none was. */
        public ?string $searchedThrough,
        /** Whether the window was searched to its start. */
        public bool $complete,
        public ?string $nextCursor,
    ) {
    }
}
