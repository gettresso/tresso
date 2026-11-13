<?php

declare(strict_types=1);

namespace App\ApiResource;

use ApiPlatform\Metadata\ApiResource;
use ApiPlatform\Metadata\Link;
use ApiPlatform\Metadata\Post;
use ApiPlatform\Metadata\Put;
use App\ApiResource\Input\Chat\RelayClaim;
use App\ApiResource\Input\Chat\RelayMediaClaim;
use App\ApiResource\Input\Chat\RelayMediaFailed;
use App\ApiResource\Input\Chat\RelayMessages;
use App\ApiResource\Input\Chat\RelayResult;
use App\ApiResource\Input\Chat\RelayStatus;
use App\ApiResource\Output\Chat\RelayClaimOutput;
use App\ApiResource\Output\Chat\RelayImportOutput;
use App\ApiResource\Output\Chat\RelayMediaClaimOutput;
use App\ApiResource\Output\Chat\RelayMediaOutput;
use App\ApiResource\Output\Chat\RelayStatusOutput;
use App\Security\ChatAccessVoter;
use App\Security\FirstPartyClients;
use App\State\ChatMediaUploadProcessor;
use App\State\ChatRelayProcessor;

/**
 * The relay: the desktop that runs the user's WhatsApp bridge passes its messages on to the server and sends the
 * replies written on other devices. Only our desktop app with `mail:write` calls these ({@see ChatAccessVoter::MANAGE}
 * and {@see FirstPartyClients::DESKTOP_ATTRIBUTE}), for an account of the signed-in user (another user's is not found),
 * and only the account's relaying device is answered: another desktop gets 409 `not_the_relay`
 * ({@see \App\Chat\ChatRelayGuard}).
 *
 * Files ({@see \App\Chat\ChatMedia}): the relay takes the oldest file the user asked for on another device, downloads
 * it through its bridge and uploads it as the raw body of a PUT (its device in `X-Device-Id`, its SHA-256 in
 * `X-Content-SHA256`), or says why it could not.
 */
#[ApiResource(
    shortName: 'ChatRelay',
    routePrefix: '/api/v1',
    normalizationContext: ['skip_null_values' => false],
    operations: [
        // The heartbeat: what the relay sees of the bridge, on connect, on every change and every minute.
        new Post(
            uriTemplate: '/chat-accounts/{accountId}/relay/status',
            uriVariables: ['accountId' => new Link(fromClass: ChatAccountResource::class, identifiers: ['id'])],
            status: 200,
            security: "is_granted('".ChatAccessVoter::MANAGE."') and is_granted('".FirstPartyClients::DESKTOP_ATTRIBUTE."')",
            input: RelayStatus::class,
            output: RelayStatusOutput::class,
            read: false,
            processor: ChatRelayProcessor::class,
            name: 'chat_relay_status',
        ),
        // At most 200 messages, 200 chats and 8 MB a call; safe to send again.
        new Post(
            uriTemplate: '/chat-accounts/{accountId}/relay/messages',
            uriVariables: ['accountId' => new Link(fromClass: ChatAccountResource::class, identifiers: ['id'])],
            status: 200,
            security: "is_granted('".ChatAccessVoter::MANAGE."') and is_granted('".FirstPartyClients::DESKTOP_ATTRIBUTE."')",
            input: RelayMessages::class,
            output: RelayImportOutput::class,
            read: false,
            // The processor checks the size in bytes before it decodes anything (413 `too_large`).
            deserialize: false,
            validate: false,
            processor: ChatRelayProcessor::class,
            name: 'chat_relay_messages',
        ),
        // The oldest reply that waits, now being sent; 204 when none waits.
        new Post(
            uriTemplate: '/chat-accounts/{accountId}/relay/outgoing/claim',
            uriVariables: ['accountId' => new Link(fromClass: ChatAccountResource::class, identifiers: ['id'])],
            status: 200,
            security: "is_granted('".ChatAccessVoter::MANAGE."') and is_granted('".FirstPartyClients::DESKTOP_ATTRIBUTE."')",
            input: RelayClaim::class,
            output: RelayClaimOutput::class,
            read: false,
            processor: ChatRelayProcessor::class,
            name: 'chat_relay_claim',
        ),
        // What became of a claimed reply. Final: the same result again is answered as the first time, another is 409.
        new Post(
            uriTemplate: '/chat-accounts/{accountId}/relay/outgoing/{outgoingId}/result',
            uriVariables: [
                'accountId' => new Link(fromClass: ChatAccountResource::class, identifiers: ['id']),
                'outgoingId' => new Link(fromClass: ChatOutgoingResource::class, identifiers: ['id']),
            ],
            status: 200,
            security: "is_granted('".ChatAccessVoter::MANAGE."') and is_granted('".FirstPartyClients::DESKTOP_ATTRIBUTE."')",
            input: RelayResult::class,
            output: ChatOutgoingResource::class,
            read: false,
            processor: ChatRelayProcessor::class,
            name: 'chat_relay_result',
        ),
        // The oldest file the user asked for that no relay holds; 204 when none waits.
        new Post(
            uriTemplate: '/chat-accounts/{accountId}/relay/media/claim',
            uriVariables: ['accountId' => new Link(fromClass: ChatAccountResource::class, identifiers: ['id'])],
            status: 200,
            security: "is_granted('".ChatAccessVoter::MANAGE."') and is_granted('".FirstPartyClients::DESKTOP_ATTRIBUTE."')",
            input: RelayMediaClaim::class,
            output: RelayMediaClaimOutput::class,
            read: false,
            processor: ChatRelayProcessor::class,
            name: 'chat_relay_media_claim',
        ),
        // The file, as the body; safe to send again.
        new Put(
            uriTemplate: '/chat-accounts/{accountId}/relay/media/{messageId}',
            uriVariables: [
                'accountId' => new Link(fromClass: ChatAccountResource::class, identifiers: ['id']),
                'messageId' => new Link(fromClass: ChatMediaResource::class, identifiers: ['messageId']),
            ],
            status: 200,
            security: "is_granted('".ChatAccessVoter::MANAGE."') and is_granted('".FirstPartyClients::DESKTOP_ATTRIBUTE."')",
            inputFormats: ['binary' => ['application/octet-stream']],
            input: false,
            output: RelayMediaOutput::class,
            read: false,
            deserialize: false,
            validate: false,
            processor: ChatMediaUploadProcessor::class,
            name: 'chat_relay_media_upload',
        ),
        // Why the relay could not bring the file. The same failure again changes nothing.
        new Post(
            uriTemplate: '/chat-accounts/{accountId}/relay/media/{messageId}/failed',
            uriVariables: [
                'accountId' => new Link(fromClass: ChatAccountResource::class, identifiers: ['id']),
                'messageId' => new Link(fromClass: ChatMediaResource::class, identifiers: ['messageId']),
            ],
            status: 200,
            security: "is_granted('".ChatAccessVoter::MANAGE."') and is_granted('".FirstPartyClients::DESKTOP_ATTRIBUTE."')",
            input: RelayMediaFailed::class,
            output: RelayMediaOutput::class,
            read: false,
            processor: ChatRelayProcessor::class,
            name: 'chat_relay_media_failed',
        ),
    ],
)]
final class ChatRelay
{
}
