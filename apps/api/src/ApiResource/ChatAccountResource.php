<?php

declare(strict_types=1);

namespace App\ApiResource;

use ApiPlatform\Metadata\ApiProperty;
use ApiPlatform\Metadata\ApiResource;
use ApiPlatform\Metadata\Delete;
use ApiPlatform\Metadata\GetCollection;
use ApiPlatform\Metadata\Patch;
use ApiPlatform\Metadata\Put;
use App\ApiResource\Input\Chat\ConnectChatAccount;
use App\ApiResource\Input\Chat\UpdateChatAccount;
use App\Chat\ChatViews;
use App\Security\ChatAccessVoter;
use App\Security\FirstPartyClients;
use App\State\ChatAccountProcessor;
use App\State\ChatAccountProvider;

/**
 * The user's WhatsApp, relayed to the server by one of their desktops ("All my devices"). Chats are private: who reads
 * them is decided by {@see ChatAccessVoter} (our own apps, or a caller holding `chat:read`). Changing or removing the
 * account is for our own apps; making it or taking over the relay is for the desktop app alone, the one that runs the
 * bridge.
 *
 * Clients keep their copy through the delta (`chatAccounts`, tombstone type `chatAccount`); a removed account means
 * its chats, messages and replies are gone too.
 *
 * @phpstan-import-type AccountView from ChatViews
 */
#[ApiResource(
    shortName: 'ChatAccount',
    routePrefix: '/api/v1',
    normalizationContext: ['skip_null_values' => false],
    operations: [
        new GetCollection(
            uriTemplate: '/chat-accounts',
            paginationEnabled: false,
            security: "is_granted('".ChatAccessVoter::READ."')",
            provider: ChatAccountProvider::class,
        ),
        // Makes the account, or makes the calling desktop its relay: another desktop that relayed sees it in the delta
        // and stops.
        new Put(
            uriTemplate: '/chat-accounts/whatsapp',
            uriVariables: [],
            status: 200,
            security: "is_granted('".ChatAccessVoter::MANAGE."') and is_granted('".FirstPartyClients::DESKTOP_ATTRIBUTE."')",
            input: ConnectChatAccount::class,
            read: false,
            processor: ChatAccountProcessor::class,
            allowCreate: true,
            name: 'chat_account_connect_whatsapp',
        ),
        new Patch(
            uriTemplate: '/chat-accounts/{id}',
            security: "is_granted('".ChatAccessVoter::MANAGE."')",
            input: UpdateChatAccount::class,
            provider: ChatAccountProvider::class,
            processor: ChatAccountProcessor::class,
        ),
        new Delete(
            uriTemplate: '/chat-accounts/{id}',
            security: "is_granted('".ChatAccessVoter::MANAGE."')",
            provider: ChatAccountProvider::class,
            processor: ChatAccountProcessor::class,
        ),
    ],
)]
final readonly class ChatAccountResource
{
    public function __construct(
        #[ApiProperty(identifier: true)]
        public string $id,
        /** `whatsapp`. */
        public string $channel,
        /** The own number, digits only. */
        public ?string $address,
        /** The own name on the channel. */
        public ?string $displayName,
        /** The desktop that relays. */
        public string $relayDeviceId,
        public string $relayDeviceName,
        /** False once the relay was not heard from for a while; replies wait until it is back. */
        public bool $relayOnline,
        public ?string $relayOfflineSince,
        /** `running` or `stopped`. */
        public string $bridge,
        /** `linked`, `unlinked` or `unknown`. */
        public string $link,
        /** When the relay saw the bridge get linked; null when it did not see it. */
        public ?string $linkedAt,
        /** Whether the bridge listens on loopback only; null until the relay checked. */
        public ?bool $loopbackOnly,
        public bool $includeGroups,
        /** Whether new messages notify the user. */
        public bool $notify,
    ) {
    }

    /**
     * @param AccountView $view
     */
    public static function fromView(array $view): self
    {
        return new self(
            $view['id'],
            $view['channel'],
            $view['address'],
            $view['displayName'],
            $view['relayDeviceId'],
            $view['relayDeviceName'],
            $view['relayOnline'],
            $view['relayOfflineSince'],
            $view['bridge'],
            $view['link'],
            $view['linkedAt'],
            $view['loopbackOnly'],
            $view['includeGroups'],
            $view['notify'],
        );
    }
}
