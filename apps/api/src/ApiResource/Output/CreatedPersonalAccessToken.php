<?php

declare(strict_types=1);

namespace App\ApiResource\Output;

use App\Security\PersonalAccessToken\IssuedPersonalAccessToken;

/**
 * A personal access token that was just made, with its secret in "token". This is the only response that ever holds
 * the secret.
 */
final class CreatedPersonalAccessToken
{
    /**
     * @param list<string> $scopes
     */
    public function __construct(
        public string $id,
        public string $name,
        public string $prefix,
        public array $scopes,
        public \DateTimeImmutable $createdAt,
        public \DateTimeImmutable $expiresAt,
        #[\SensitiveParameter]
        public string $token,
    ) {
    }

    public static function fromIssued(IssuedPersonalAccessToken $issued): self
    {
        $token = $issued->token;

        return new self(
            $token->getId()->toRfc4122(),
            $token->getName(),
            $token->getPrefix(),
            $token->getScopes(),
            $token->getCreatedAt(),
            $token->getExpiresAt(),
            $issued->secret,
        );
    }
}
