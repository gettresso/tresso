<?php

declare(strict_types=1);

namespace App\ApiResource;

use ApiPlatform\Metadata\ApiResource;
use ApiPlatform\Metadata\Get;
use App\Chat\ChatReader;
use App\Security\ChatAccessVoter;
use App\State\ChatReadProvider;

/**
 * Whether the user's WhatsApp is on the server ("All my devices") and the state of the desktop that relays it. With
 * "Only this Mac", or before WhatsApp is connected, the server holds no chats: `onServer` is false and the rest null.
 * Read with {@see ChatAccessVoter::READ} or {@see ChatAccessVoter::SEND}: it holds no number or message, so a caller
 * that may only queue replies learns whether they can go out, and nothing about the chats; such a caller does not get
 * the relay's device name either.
 *
 * @phpstan-import-type Status from ChatReader
 */
#[ApiResource(
    shortName: 'ChatStatus',
    routePrefix: '/api/v1',
    normalizationContext: ['skip_null_values' => false],
    operations: [
        new Get(
            uriTemplate: '/chat-accounts/whatsapp/status',
            uriVariables: [],
            security: "is_granted('".ChatAccessVoter::READ."') or is_granted('".ChatAccessVoter::SEND."')",
            provider: ChatReadProvider::class,
            name: ChatReadProvider::STATUS,
        ),
    ],
)]
final readonly class ChatStatus
{
    public function __construct(
        /** `whatsapp`. */
        public string $channel,
        /** False with "Only this Mac" or when WhatsApp is not connected: the server then holds no chats. */
        public bool $onServer,
        public ?string $chatAccountId,
        /** The name of the desktop that relays; null for a caller that may only queue replies. */
        public ?string $relayDeviceName,
        /** False once the relay was not heard from for 3 minutes; replies wait until it is back. */
        public ?bool $relayOnline,
        public ?string $relayOfflineSince,
        /** `running` or `stopped`. */
        public ?string $bridge,
        /** `linked`, `unlinked` or `unknown`. */
        public ?string $link,
    ) {
    }

    /**
     * @param Status $status
     */
    public static function fromArray(array $status): self
    {
        return new self(
            $status['channel'],
            $status['onServer'],
            $status['chatAccountId'],
            $status['relayDeviceName'],
            $status['relayOnline'],
            $status['relayOfflineSince'],
            $status['bridge'],
            $status['link'],
        );
    }
}
