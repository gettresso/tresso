<?php

declare(strict_types=1);

namespace App\Security\OAuth;

use League\OAuth2\Server\Entities\AccessTokenEntityInterface;
use League\OAuth2\Server\Entities\ScopeEntityInterface;
use League\OAuth2\Server\ResponseTypes\BearerTokenResponse;

/**
 * The token endpoint's answer with the scopes the token holds (`scope`, RFC 6749 5.1). The token can hold fewer than
 * were asked for (WhatsApp scopes the user left unticked, {@see TokensNeedConsent}), and the RFC requires `scope` then;
 * it is sent every time, so a client never has to guess. Set as the bundle's `response_type_class`.
 */
final class ScopedBearerTokenResponse extends BearerTokenResponse
{
    /**
     * @return array<string, string>
     */
    protected function getExtraParams(#[\SensitiveParameter] AccessTokenEntityInterface $accessToken): array
    {
        return ['scope' => implode(' ', array_map(static fn (ScopeEntityInterface $scope): string => $scope->getIdentifier(), $accessToken->getScopes()))];
    }
}
