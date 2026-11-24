<?php

declare(strict_types=1);

namespace App\ApiResource;

use ApiPlatform\Metadata\ApiProperty;
use ApiPlatform\Metadata\ApiResource;
use ApiPlatform\Metadata\Delete;
use ApiPlatform\Metadata\GetCollection;
use ApiPlatform\Metadata\Patch;
use App\Activity\ActivityApp;
use App\ApiResource\Input\UpdateConnectedApp;
use App\Entity\OAuthConsent;
use App\Security\FirstPartyClients;
use App\Security\OAuth\AppAddress;
use App\Security\Scope;
use App\State\ConnectedAppProcessor;
use App\State\ConnectedAppProvider;

/**
 * An app that is not ours which the signed-in user allowed to act for them (through the consent screen). Only our own
 * apps may list, narrow or disconnect them, so a connected app cannot see or remove others, widen itself or keep itself
 * connected. Deleting disconnects the app: its tokens for this user stop working at once.
 *
 * `scopes` is what the app may do now; `grantedScopes` is what the user granted on the consent screen, which the app
 * can be narrowed within: PATCH with the `scopes` it keeps switches the others off, from the app's next request on,
 * also with tokens it already holds ({@see \App\Security\OAuth\NarrowedScopes}), and switches back on any granted
 * scope it names. A scope that was never granted is refused (422): that needs the consent screen.
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
        new Patch(
            uriTemplate: '/connected-apps/{id}',
            security: "is_granted('".Scope::ROLE_SETTINGS_WRITE."') and is_granted('".FirstPartyClients::ATTRIBUTE."')",
            input: UpdateConnectedApp::class,
            provider: ConnectedAppProvider::class,
            processor: ConnectedAppProcessor::class,
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
     * @param list<string> $domains
     * @param list<string> $scopes
     * @param list<string> $grantedScopes
     */
    public function __construct(
        #[ApiProperty(identifier: true)]
        public string $id,
        /** The name the app gave itself; not checked by anyone. */
        public string $name,
        /**
         * Every place the app may send the user back to, which is what is checked: hosts, a loopback host for an app on
         * this computer, or an app's reverse-domain scheme.
         *
         * @var list<string>
         */
        public array $domains,
        /**
         * What the app may do now: the granted scopes without those switched off.
         *
         * @var list<string>
         */
        public array $scopes,
        /**
         * What the user granted the app on the consent screen; the app can be switched back on to any of these.
         *
         * @var list<string>
         */
        public array $grantedScopes,
        /** When the user first allowed the app. */
        public \DateTimeImmutable $connectedAt,
        /** When the app last got a token for this user, to within the hour. */
        public ?\DateTimeImmutable $lastUsedAt,
        /** The app in the activity log, for its `app` filter (`client:<client id>`). */
        public string $activityKey,
    ) {
    }

    public static function fromEntity(OAuthConsent $consent): self
    {
        return new self(
            $consent->getId()->toRfc4122(),
            $consent->getClient()->getName(),
            AppAddress::domainsOf($consent->getClient()->getRedirectUris()),
            $consent->getAllowedScopes(),
            $consent->getScopes(),
            $consent->getCreatedAt(),
            $consent->getLastUsedAt(),
            ActivityApp::client(rtrim($consent->getClient()->getIdentifier()))->key(),
        );
    }
}
