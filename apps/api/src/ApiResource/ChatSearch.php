<?php

declare(strict_types=1);

namespace App\ApiResource;

use ApiPlatform\Metadata\ApiResource;
use ApiPlatform\Metadata\Post;
use App\ApiResource\Input\Chat\SearchChats;
use App\Chat\ChatReader;
use App\Security\ChatAccessVoter;
use App\State\ChatSearchProcessor;

/**
 * Searches the user's WhatsApp messages on the server. A POST with a JSON body, so the text searched for never sits in
 * a URL; it changes nothing and can be repeated. `q` (2 to 200 characters, matched anywhere in a message's text, file
 * name or sender name, ignoring case and Unicode compatibility forms), `days` (how far back, 1 to 90, default 30),
 * `chatId` (only this chat), `limit` (results, 1 to 50, default 20) and `cursor` (the `nextCursor` of the call
 * before).
 *
 * Chat text is sealed at rest and never indexed, so each message is opened to be compared: a call opens at most
 * {@see ChatReader::SEARCH_SCAN} messages, newest first. `scanned` says how many it opened and `searchedThrough` the
 * time of the oldest; when `complete` is false the window was not searched to its start, and `nextCursor` goes on from
 * there. Searches are limited per caller (`chat_search_caller`: an app or a token of the user) and per user
 * (`chat_search`), 429 above either. Chats the user left out are not searched. Each
 * result is a message as the delta's `chatMessages` has it, with its chat's `chatName` and `chatKind`. Needs
 * {@see ChatAccessVoter::READ}.
 */
#[ApiResource(
    shortName: 'ChatSearch',
    routePrefix: '/api/v1',
    normalizationContext: ['skip_null_values' => false],
    operations: [
        new Post(
            uriTemplate: '/chat-messages/search',
            status: 200,
            security: "is_granted('".ChatAccessVoter::READ."')",
            input: SearchChats::class,
            read: false,
            // The processor reads and validates the body itself (App\Chat\ChatRequestBody), with a size limit.
            deserialize: false,
            validate: false,
            processor: ChatSearchProcessor::class,
            name: 'chat_search',
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
