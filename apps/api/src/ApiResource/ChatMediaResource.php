<?php

declare(strict_types=1);

namespace App\ApiResource;

use ApiPlatform\Metadata\ApiProperty;
use ApiPlatform\Metadata\ApiResource;
use ApiPlatform\Metadata\Get;
use ApiPlatform\Metadata\Post;
use App\ApiResource\Input\ConfirmUnscannedInput;
use App\Security\ChatAccessVoter;
use App\Security\FirstPartyClients;
use App\State\ChatMediaProcessor;
use App\State\ChatMediaProvider;

/**
 * The file of a chat message ("All my devices"). It stays on the relaying Mac until the user asks for it on another
 * device ({@see \App\Chat\ChatMedia}); nothing downloads without that.
 *
 * - `POST .../media/request` asks the Mac for it (our own apps, {@see ChatAccessVoter::MANAGE}): `remote` or `failed`
 *   to `requested`; one asked for already or stored stays as it is.
 * - `GET .../media` says where it stands and, once it is stored and scanned clean, gives a signed link valid for an hour
 *   ({@see ChatAccessVoter::READ}). The content is served as a download, never sniffed and sandboxed, as attachments are.
 * - `POST .../media/unscanned-link` gives the link for a file that could not be scanned, to a user who confirmed they
 *   accept that (our own apps); never on a server that requires scans.
 *
 * Another user's message, and a message without a file, are not found.
 */
#[ApiResource(
    shortName: 'ChatMedia',
    routePrefix: '/api/v1',
    normalizationContext: ['skip_null_values' => false],
    operations: [
        new Get(
            uriTemplate: '/chat-messages/{messageId}/media',
            security: "is_granted('".ChatAccessVoter::READ."')",
            provider: ChatMediaProvider::class,
            name: self::SHOW,
        ),
        new Post(
            uriTemplate: '/chat-messages/{messageId}/media/request',
            status: 200,
            security: "is_granted('".ChatAccessVoter::MANAGE."')",
            input: false,
            read: false,
            processor: ChatMediaProcessor::class,
            name: self::REQUEST,
        ),
        new Post(
            uriTemplate: '/chat-messages/{messageId}/media/unscanned-link',
            status: 200,
            security: "is_granted('".ChatAccessVoter::READ."') and is_granted('".FirstPartyClients::ATTRIBUTE."')",
            input: ConfirmUnscannedInput::class,
            read: false,
            processor: ChatMediaProcessor::class,
            name: self::UNSCANNED,
        ),
    ],
)]
final readonly class ChatMediaResource
{
    public const string SHOW = 'chat_media_show';
    public const string REQUEST = 'chat_media_request';
    public const string UNSCANNED = 'chat_media_unscanned_link';

    public function __construct(
        #[ApiProperty(identifier: true)]
        public string $messageId,
        /** `image`, `video`, `audio` or `document`. */
        public string $kind,
        /** The file's name as WhatsApp gave it; null when it gave none. */
        public ?string $name,
        /** Bytes: the stored file's size, or what the bridge's store said before; null when unknown. */
        public ?int $size,
        /** `remote` (on the Mac), `requested`, `stored` or `failed`. */
        public string $state,
        /** Why the Mac could not bring it: `not_found`, `mismatch`, `unverified`, `too_large` or `unavailable`. */
        public ?string $error,
        /** For a stored file, from its scan: `allowed`, `scanning`, `confirm` or `blocked`; null while it is not stored. */
        public ?string $access,
        /** A signed link to the content, valid for an hour; null until it may be downloaded. */
        public ?string $url,
    ) {
    }
}
