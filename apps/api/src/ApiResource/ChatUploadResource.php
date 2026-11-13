<?php

declare(strict_types=1);

namespace App\ApiResource;

use ApiPlatform\Metadata\ApiProperty;
use ApiPlatform\Metadata\ApiResource;
use ApiPlatform\Metadata\Link;
use ApiPlatform\Metadata\Put;
use App\Security\ChatAccessVoter;
use App\Security\FirstPartyClients;
use App\State\ChatUploadProcessor;

/**
 * A file for a reply, uploaded before the reply is queued (`POST /api/v1/chats/{chatId}/outgoing` with `file`): the raw
 * body of a PUT under an id the client makes, at most {@see \App\Chat\ChatMediaLimits} (413 `too_large`), its type in
 * `Content-Type` and optionally its SHA-256 in `X-Content-SHA256`. The same id with the same content again is answered
 * with the upload it made (200), with other content 409 `id_taken`. Only our own apps attach files
 * ({@see ChatAccessVoter::SEND} and {@see FirstPartyClients::ATTRIBUTE}); another user's chat is not found, a chat left
 * out is 422. An upload no reply took within an hour is removed ({@see \App\Chat\ChatUploads}).
 */
#[ApiResource(
    shortName: 'ChatUpload',
    routePrefix: '/api/v1',
    operations: [
        new Put(
            uriTemplate: '/chats/{chatId}/uploads/{id}',
            uriVariables: [
                'chatId' => new Link(fromClass: ChatResource::class, identifiers: ['id']),
                'id' => new Link(fromClass: self::class, identifiers: ['id']),
            ],
            status: 201,
            security: "is_granted('".ChatAccessVoter::SEND."') and is_granted('".FirstPartyClients::ATTRIBUTE."')",
            inputFormats: ['binary' => ['application/octet-stream']],
            input: false,
            read: false,
            deserialize: false,
            validate: false,
            processor: ChatUploadProcessor::class,
            name: 'chat_upload',
        ),
    ],
)]
final readonly class ChatUploadResource
{
    public function __construct(
        #[ApiProperty(identifier: true)]
        public string $id,
        public string $chatId,
        /** Bytes. */
        public int $size,
    ) {
    }
}
