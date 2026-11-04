<?php

declare(strict_types=1);

namespace App\ApiResource;

use ApiPlatform\Metadata\ApiProperty;
use ApiPlatform\Metadata\ApiResource;
use ApiPlatform\Metadata\Post;
use App\ApiResource\Input\CompleteProviderAuthorization;
use App\Security\FirstPartyClients;
use App\Security\Scope;
use App\State\ProviderConnectionProcessor;

/**
 * Finishes a sign-in at Google or Microsoft (see {@see ProviderAuthorization}). The web app posts the `state` and the
 * `code` (or `error`) the API's callback passed on to it, with the access token of the user who started the sign-in.
 * The answer says what was connected (`connected`: the mail account id; `grant`: the grant, when only calendars were
 * allowed) or why not (`connectError`). A state works once.
 */
#[ApiResource(
    shortName: 'ProviderConnection',
    routePrefix: '/api/v1',
    normalizationContext: ['skip_null_values' => false],
    operations: [
        new Post(
            uriTemplate: '/provider-connections',
            status: 200,
            security: "is_granted('".Scope::ROLE_SETTINGS_WRITE."') and is_granted('".FirstPartyClients::ATTRIBUTE."')",
            input: CompleteProviderAuthorization::class,
            read: false,
            processor: ProviderConnectionProcessor::class,
        ),
    ],
)]
final readonly class ProviderConnection
{
    public function __construct(
        #[ApiProperty(identifier: true)]
        public string $provider,
        public ?string $connected,
        public ?string $grant,
        /** denied, expired, different_user, scopes_missing, wrong_account, already_connected, unverified_address, no_mailbox or failed */
        public ?string $connectError,
    ) {
    }
}
