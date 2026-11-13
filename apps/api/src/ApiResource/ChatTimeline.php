<?php

declare(strict_types=1);

namespace App\ApiResource;

use ApiPlatform\Metadata\ApiResource;
use ApiPlatform\Metadata\Get;
use ApiPlatform\Metadata\Link;
use App\Security\ChatAccessVoter;
use App\State\ChatReadProvider;

/**
 * One WhatsApp chat with its messages and the user's replies, newest first, a page at a time: `limit` (1 to 100,
 * default 30) and `cursor` (the `nextCursor` of the page before; null on the last page). Each item has a `type`:
 * `message` (as the delta's `chatMessages`) or `reply` (as `chatOutgoing`, with its status: `waiting`, `sending`,
 * `sent` or `failed`). A reply sorts by when it went out, or else by when it was written; replies the user cancelled
 * are left out, and so is a sent reply the bridge also stored as an own message, as the apps show it. Needs
 * {@see ChatAccessVoter::READ}. Another user's chat, and a chat the user left out, is not found.
 */
#[ApiResource(
    shortName: 'ChatTimeline',
    routePrefix: '/api/v1',
    normalizationContext: ['skip_null_values' => false],
    operations: [
        new Get(
            uriTemplate: '/chats/{id}/messages',
            uriVariables: ['id' => new Link(fromClass: ChatResource::class, identifiers: ['id'])],
            security: "is_granted('".ChatAccessVoter::READ."')",
            provider: ChatReadProvider::class,
            name: ChatReadProvider::TIMELINE,
        ),
    ],
)]
final readonly class ChatTimeline
{
    /**
     * @param array<string, mixed>       $chat
     * @param list<array<string, mixed>> $items
     */
    public function __construct(
        public array $chat,
        public array $items,
        public ?string $nextCursor,
    ) {
    }
}
