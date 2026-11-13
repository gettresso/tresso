<?php

declare(strict_types=1);

namespace App\ApiResource;

use ApiPlatform\Metadata\ApiProperty;
use ApiPlatform\Metadata\ApiResource;
use ApiPlatform\Metadata\Get;
use App\State\ChatFileContentProvider;

/**
 * The bytes of the file a reply carries, through the signed link the relaying desktop gets with its claim
 * ({@see \App\Chat\ChatMediaUrls::forReply()}), only while the reply is being sent. Always a download.
 */
#[ApiResource(
    shortName: 'ChatFileContent',
    routePrefix: '/content',
    operations: [
        new Get(
            uriTemplate: '/chat-files/{id}',
            name: self::ROUTE,
            provider: ChatFileContentProvider::class,
            formats: ['binary' => ['application/octet-stream']],
            openapi: false,
        ),
    ],
)]
final readonly class ChatFileContent
{
    public const string ROUTE = 'chat_file_content';

    public function __construct(
        #[ApiProperty(identifier: true)]
        public string $id,
    ) {
    }
}
