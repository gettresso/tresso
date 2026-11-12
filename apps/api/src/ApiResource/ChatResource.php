<?php

declare(strict_types=1);

namespace App\ApiResource;

use ApiPlatform\Metadata\ApiProperty;
use ApiPlatform\Metadata\ApiResource;
use ApiPlatform\Metadata\Patch;
use App\ApiResource\Input\Chat\UpdateChat;
use App\Chat\ChatViews;
use App\Security\ChatAccessVoter;
use App\State\ChatProcessor;
use App\State\ChatProvider;

/**
 * A WhatsApp chat on the server, and Tresso's own state of it: read, archived, left out. None of this reaches WhatsApp.
 * Changing it is for our own apps ({@see ChatAccessVoter::MANAGE}); clients read chats through the delta (`chats`).
 * Another user's chat is not found.
 *
 * @phpstan-import-type ChatView from ChatViews
 */
#[ApiResource(
    shortName: 'Chat',
    routePrefix: '/api/v1',
    normalizationContext: ['skip_null_values' => false],
    operations: [
        new Patch(
            uriTemplate: '/chats/{id}',
            security: "is_granted('".ChatAccessVoter::MANAGE."')",
            input: UpdateChat::class,
            provider: ChatProvider::class,
            processor: ChatProcessor::class,
        ),
    ],
)]
final readonly class ChatResource
{
    public function __construct(
        #[ApiProperty(identifier: true)]
        public string $id,
        public string $chatAccountId,
        public string $jid,
        public ?string $name,
        /** `direct` or `group`. */
        public string $kind,
        public string $lastMessageAt,
        /** The newest message the user has seen in Tresso; incoming messages after it are unread. */
        public ?string $readThrough,
        /** The chat is out of the inbox while its last message is not after this. */
        public ?string $archivedThrough,
        /** Nothing of a left-out chat is on the server or relayed. */
        public bool $leftOut,
    ) {
    }

    /**
     * @param ChatView $view
     */
    public static function fromView(array $view): self
    {
        return new self(
            $view['id'],
            $view['chatAccountId'],
            $view['jid'],
            $view['name'],
            $view['kind'],
            $view['lastMessageAt'],
            $view['readThrough'],
            $view['archivedThrough'],
            $view['leftOut'],
        );
    }
}
