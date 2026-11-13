<?php

declare(strict_types=1);

namespace App\ApiResource;

use ApiPlatform\Metadata\ApiProperty;
use ApiPlatform\Metadata\ApiResource;
use ApiPlatform\Metadata\Get;
use App\State\ChatMediaContentProvider;

/**
 * The bytes of a WhatsApp file the relaying Mac brought, through a signed link ({@see \App\Chat\ChatMediaUrls}), served
 * like an attachment: a download, never sniffed, sandboxed, plain images inline.
 */
#[ApiResource(
    shortName: 'ChatMediaContent',
    routePrefix: '/content',
    operations: [
        new Get(
            uriTemplate: '/chat-media/{id}',
            name: self::ROUTE,
            provider: ChatMediaContentProvider::class,
            formats: ['binary' => ['application/octet-stream']],
            openapi: false,
        ),
    ],
)]
final readonly class ChatMediaContent
{
    public const string ROUTE = 'chat_media_content';

    public function __construct(
        #[ApiProperty(identifier: true)]
        public string $id,
    ) {
    }
}
