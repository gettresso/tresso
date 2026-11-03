<?php

declare(strict_types=1);

namespace App\Security\PersonalAccessToken;

use App\Entity\PersonalAccessToken;

/**
 * A token that was just made, with its secret. Nothing keeps the secret after the response that hands it out.
 */
final readonly class IssuedPersonalAccessToken
{
    public function __construct(
        public PersonalAccessToken $token,
        #[\SensitiveParameter]
        public string $secret,
    ) {
    }

    /** @return array<string, string> */
    public function __debugInfo(): array
    {
        return ['token' => $this->token->getId()->toRfc4122(), 'secret' => '[redacted]'];
    }
}
