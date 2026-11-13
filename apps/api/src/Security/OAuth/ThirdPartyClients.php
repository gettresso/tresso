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

    /**
     * Every scope such an app may hold, as the metadata advertises them (`scopes_supported`).
     *
     * @return list<string>
     */
    public static function scopeValues(): array
    {
        return array_map(static fn (Scope $scope): string => $scope->value, Scope::thirdPartyAppScopes());
    }

    /**
     * What an app that registers without naming scopes may ask for: everything offered except the chat scopes, which
     * an app only gets by naming them when it registers.
     *
     * @return list<string>
     */
    public static function defaultScopeValues(): array
    {
        return array_map(static fn (Scope $scope): string => $scope->value, Scope::thirdPartyDefaultScopes());
    }

    /** Only what is offered ({@see scopeValues()}). */
    public static function mayAskFor(string $scope): bool
    {
        return \in_array($scope, self::scopeValues(), true);
    }
}
