<?php

declare(strict_types=1);

namespace App\ApiResource;

use ApiPlatform\Metadata\ApiResource;
use ApiPlatform\Metadata\Get;
use App\Security\ChatAccessVoter;
use App\State\ChatReadProvider;

/**
 * The user's WhatsApp chats on the server, the chat with the newest message first, a page at a time: `limit` (1 to
 * 100, default 25) and `cursor` (the `nextCursor` of the page before; null on the last page). Chats the user left out
 * are not listed. Each chat as the delta's `chats` has it. Needs {@see ChatAccessVoter::READ}; for callers that keep no
 * copy through the delta, which needs `mail:read`.
 */
#[ApiResource(
    shortName: 'ChatList',
    routePrefix: '/api/v1',
    normalizationContext: ['skip_null_values' => false],
    operations: [
        new Get(
            uriTemplate: '/chats',
            uriVariables: [],
            security: "is_granted('".ChatAccessVoter::READ."')",
            provider: ChatReadProvider::class,
            name: ChatReadProvider::CHATS,
        ),
    ],
)]
final readonly class ChatList
{
    /**
     * @param list<array<string, mixed>> $items
     */
    public function __construct(
        public array $items,
        public ?string $nextCursor,
    ) {
    }
}
