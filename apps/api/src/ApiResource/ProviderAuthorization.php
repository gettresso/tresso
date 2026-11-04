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
 * A started sign-in at Google or Microsoft. The client sends the browser to `authorizationUrl`; afterwards the provider
 * returns the browser to the API, which passes its answer on to the web app (/settings/accounts/new, or
 * /settings/accounts when signing in again) as `state` plus `code` or `error` in the query, or straight away
 * `connectError=expired` for a state it does not know. The web app finishes with {@see ProviderConnection}. A sign-in
 * started with `returnTo: native` (the desktop app, which opens the provider in the system browser) gets the same
 * query through NATIVE_REDIRECT_URI instead, with the web app page in `next`.
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
