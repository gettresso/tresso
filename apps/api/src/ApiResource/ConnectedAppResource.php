<?php

declare(strict_types=1);

namespace App\ApiResource;

use ApiPlatform\Metadata\ApiProperty;
use ApiPlatform\Metadata\ApiResource;
use ApiPlatform\Metadata\Delete;
use ApiPlatform\Metadata\GetCollection;
use App\Entity\OAuthConsent;
use App\Security\FirstPartyClients;
use App\Security\OAuth\AppAddress;
use App\Security\Scope;
use App\State\ConnectedAppProcessor;
use App\State\ConnectedAppProvider;

/**
 * An app that is not ours which the signed-in user allowed to act for them (through the consent screen). Only our own
 * apps may list or disconnect them, so a connected app cannot see or remove others, or keep itself connected.
 * Deleting disconnects the app: its tokens for this user stop working at once.
 */
#[ApiResource(
    shortName: 'ConnectedApp',
    routePrefix: '/api/v1',
    normalizationContext: ['skip_null_values' => false],
    operations: [
        new GetCollection(
            uriTemplate: '/connected-apps',
            paginationEnabled: false,
            security: "is_granted('".Scope::ROLE_SETTINGS_READ."') and is_granted('".FirstPartyClients::ATTRIBUTE."')",
            provider: ConnectedAppProvider::class,
        ),
        new Delete(
            uriTemplate: '/connected-apps/{id}',
            security: "is_granted('".Scope::ROLE_SETTINGS_WRITE."') and is_granted('".FirstPartyClients::ATTRIBUTE."')",
            provider: ConnectedAppProvider::class,
            processor: ConnectedAppProcessor::class,
        ),
    ],
)]
final class ConnectedAppResource
{
    /**
     * @param list<string> $scopes
     */
    public function __construct(
        #[ApiProperty(identifier: true)]
        public string $id,
        /** The name the app gave itself; not checked by anyone. */
        public string $name,
        /** Where the app sends the user back to, which is checked: the host, `localhost`, or `scheme://host`. */
        public string $domain,
        public array $scopes,
        /** When the user first allowed the app. */
        public \DateTimeImmutable $connectedAt,
        /** When the app last got a token for this user, to within the hour. */
        public ?\DateTimeImmutable $lastUsedAt,
    ) {
    }

    public static function fromEntity(OAuthConsent $consent): self
    {
        $redirectUri = $consent->getClient()->getRedirectUris()[0] ?? null;

        return new self(
            $consent->getId()->toRfc4122(),
            $consent->getClient()->getName(),
            null === $redirectUri ? '' : AppAddress::of((string) $redirectUri)->domain,
            $consent->getScopes(),
            $consent->getCreatedAt(),
            $consent->getLastUsedAt(),
        );
    }
}
