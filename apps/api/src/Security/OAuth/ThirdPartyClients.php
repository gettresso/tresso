<?php

declare(strict_types=1);

namespace App\Security\OAuth;

use App\Security\Scope;

/**
 * Apps that are not ours: what they may ask for. They sign in with the authorization code grant and PKCE (S256), as
 * public clients, and get a consent screen ({@see ConsentScreen}).
 */
final class ThirdPartyClients
{
    public const array GRANT_TYPES = ['authorization_code', 'refresh_token'];

    /** @return list<string> */
    public static function scopeValues(): array
    {
        return array_map(static fn (Scope $scope): string => $scope->value, Scope::thirdPartyAppScopes());
    }

    public static function mayAskFor(string $scope): bool
    {
        return \in_array($scope, self::scopeValues(), true);
    }
}
