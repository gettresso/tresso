<?php

declare(strict_types=1);

namespace App\ApiResource;

use ApiPlatform\Metadata\ApiProperty;
use ApiPlatform\Metadata\ApiResource;
use ApiPlatform\Metadata\Delete;
use ApiPlatform\Metadata\Link;
use ApiPlatform\Metadata\Post;
use App\ApiResource\Input\Chat\QueueReply;
use App\Chat\ChatViews;
use App\Security\ChatAccessVoter;
use App\Security\FirstPartyClients;
use App\State\ChatOutgoingProcessor;
use App\State\ChatOutgoingProvider;

/**
 * The reply queue: a reply written on any device waits here until the relaying desktop sends it ({@see \App\Chat\ChatQueue}).
 * Queueing and cancelling need {@see ChatAccessVoter::SEND} (our own apps with `mail:send`, or a caller holding
 * `chat:send`); trying again also needs one of our own apps; clients read replies through the delta (`chatOutgoing`). Another user's chat or reply is not
 * found.
 *
 * @phpstan-import-type OutgoingView from ChatViews
 */
#[ApiResource(
    shortName: 'ChatOutgoing',
    routePrefix: '/api/v1',
    normalizationContext: ['skip_null_values' => false],
    operations: [
        // 201 with the new reply; 200 with the stored one when its id was queued before in the same chat.
        new Post(
            uriTemplate: '/chats/{chatId}/outgoing',
            uriVariables: ['chatId' => new Link(fromClass: ChatResource::class, identifiers: ['id'])],
            status: 201,
            security: "is_granted('".ChatAccessVoter::SEND."')",
            input: QueueReply::class,
            read: false,
            // The body names the reply's `id`, which API Platform would take for an update of an existing item: the
            // processor reads and validates the body itself.
            deserialize: false,
            validate: false,
            processor: ChatOutgoingProcessor::class,
            name: 'chat_outgoing_queue',
        ),
        // A reply that waits or failed; one that is being sent or was sent is 409 `already_going_out`. Also an id the
        // server has not seen yet, while a new reply could have it: its queueing, arriving later, is refused
        // (ChatQueue::cancel()). Not read first: the processor loads the reply through the user.
        new Delete(
            uriTemplate: '/chat-outgoing/{id}',
            security: "is_granted('".ChatAccessVoter::SEND."')",
            read: false,
            processor: ChatOutgoingProcessor::class,
        ),
        // Try again: a reply that failed waits again; any other is 409 `not_failed`. Only in our own apps, where the user
        // decides: a reply that failed as `unconfirmed` may have gone out, and a tool must not send it twice.
        new Post(
            uriTemplate: '/chat-outgoing/{id}/retry',
            status: 200,
            security: "is_granted('".ChatAccessVoter::SEND."') and is_granted('".FirstPartyClients::ATTRIBUTE."')",
            input: false,
            provider: ChatOutgoingProvider::class,
            processor: ChatOutgoingProcessor::class,
            name: 'chat_outgoing_retry',
        ),
    ],
)]
final readonly class ChatOutgoingResource
{
    /**
     * @param array{name: string, size: ?int}|null $file the file it carries, its name and size in bytes; null for a text reply
     */
    public function __construct(
        #[ApiProperty(identifier: true)]
        public string $id,
        public string $chatId,
        public string $chatAccountId,
        public string $text,
        /** `waiting`, `sending`, `sent` or `failed`. */
        public string $status,
        /** Why it failed: `bridge_stopped`, `not_linked`, `refused` or `unconfirmed` (it may have gone out). */
        public ?string $error,
        public string $createdAt,
        public ?string $claimedAt,
        public ?string $sentAt,
        public ?array $file = null,
    ) {
    }

    /**
     * @param OutgoingView $view
     */
    public static function fromView(array $view): self
    {
        return new self(
            $view['id'],
            $view['chatId'],
            $view['chatAccountId'],
            $view['text'],
            $view['status'],
            $view['error'],
            $view['createdAt'],
            $view['claimedAt'],
            $view['sentAt'],
            $view['file'],
        );
    }
}
