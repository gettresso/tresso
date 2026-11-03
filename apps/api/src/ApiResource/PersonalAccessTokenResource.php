<?php

declare(strict_types=1);

namespace App\ApiResource;

use ApiPlatform\Metadata\ApiProperty;
use ApiPlatform\Metadata\ApiResource;
use ApiPlatform\Metadata\Delete;
use ApiPlatform\Metadata\GetCollection;
use ApiPlatform\Metadata\Post;
use App\ApiResource\Input\CreatePersonalAccessToken;
use App\ApiResource\Output\CreatedPersonalAccessToken;
use App\Entity\PersonalAccessToken;
use App\Security\FirstPartyClients;
use App\Security\Scope;
use App\State\PersonalAccessTokenProcessor;
use App\State\PersonalAccessTokenProvider;

/**
 * A personal access token of the signed-in user, without its secret: the secret is only in the response that made it.
 * Only our own apps may list, make or revoke tokens, so a personal access token (or a third-party app) cannot make
 * itself more of them. Deleting revokes the token; the row goes some time later.
 */
#[ApiResource(
    shortName: 'PersonalAccessToken',
    routePrefix: '/api/v1',
    normalizationContext: ['skip_null_values' => false],
    operations: [
        new GetCollection(
            uriTemplate: '/personal-access-tokens',
            paginationEnabled: false,
            security: "is_granted('".Scope::ROLE_SETTINGS_READ."') and is_granted('".FirstPartyClients::ATTRIBUTE."')",
            provider: PersonalAccessTokenProvider::class,
        ),
        new Post(
            uriTemplate: '/personal-access-tokens',
            security: "is_granted('".Scope::ROLE_SETTINGS_WRITE."') and is_granted('".FirstPartyClients::ATTRIBUTE."')",
            input: CreatePersonalAccessToken::class,
            output: CreatedPersonalAccessToken::class,
            read: false,
            processor: PersonalAccessTokenProcessor::class,
        ),
        new Delete(
            uriTemplate: '/personal-access-tokens/{id}',
            security: "is_granted('".Scope::ROLE_SETTINGS_WRITE."') and is_granted('".FirstPartyClients::ATTRIBUTE."')",
            provider: PersonalAccessTokenProvider::class,
            processor: PersonalAccessTokenProcessor::class,
        ),
    ],
)]
final class PersonalAccessTokenResource
{
    /**
     * @param list<string> $scopes
     */
    public function __construct(
        #[ApiProperty(identifier: true)]
        public string $id,
        public string $name,
        /** The start of the secret, to tell tokens apart. */
        public string $prefix,
        public array $scopes,
        public \DateTimeImmutable $createdAt,
        public \DateTimeImmutable $expiresAt,
        public ?\DateTimeImmutable $lastUsedAt,
        public ?\DateTimeImmutable $revokedAt,
    ) {
    }

    public static function fromEntity(PersonalAccessToken $token): self
    {
        return new self(
            $token->getId()->toRfc4122(),
            $token->getName(),
            $token->getPrefix(),
            $token->getScopes(),
            $token->getCreatedAt(),
            $token->getExpiresAt(),
            $token->getLastUsedAt(),
            $token->getRevokedAt(),
        );
    }
}
