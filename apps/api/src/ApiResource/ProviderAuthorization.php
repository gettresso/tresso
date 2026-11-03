<?php

declare(strict_types=1);

namespace App\ApiResource;

use ApiPlatform\Metadata\ApiProperty;
use ApiPlatform\Metadata\ApiResource;
use ApiPlatform\Metadata\Post;
use App\ApiResource\Input\StartProviderAuthorization;
use App\Security\FirstPartyClients;
use App\Security\Scope;
use App\State\ProviderAuthorizationProcessor;

/**
 * A started sign-in at Google or Microsoft. The client sends the browser to `authorizationUrl`; after the user
 * allowed access there, the provider returns the browser to the API, which connects the account and redirects to the
 * web app (/settings/accounts/new, or /settings/accounts when signing in again) with `connected=<mail account id>` or
 * `connectError=<code>` in the query. The browser must be signed in to Tresso as the same user.
 */
#[ApiResource(
    shortName: 'ProviderAuthorization',
    routePrefix: '/api/v1',
    operations: [
        new Post(
            uriTemplate: '/provider-authorizations',
            security: "is_granted('".Scope::ROLE_SETTINGS_WRITE."') and is_granted('".FirstPartyClients::ATTRIBUTE."')",
            input: StartProviderAuthorization::class,
            read: false,
            processor: ProviderAuthorizationProcessor::class,
        ),
    ],
)]
final readonly class ProviderAuthorization
{
    public function __construct(
        public string $authorizationUrl,
        #[ApiProperty(identifier: true)]
        public string $provider,
        /** The sign-in has to be finished before this. */
        public \DateTimeImmutable $expiresAt,
    ) {
    }
}
