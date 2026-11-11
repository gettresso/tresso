<?php

declare(strict_types=1);

namespace App\Security\OAuth;

/**
 * A token this server issued, as {@see IssuedTokens} read it: its kind, its id, the client it was issued to and the
 * access token it belongs to (an access token's own id; for a refresh token, the access token issued with it).
 */
final readonly class IssuedToken
{
    public const string ACCESS_TOKEN = 'access_token';
    public const string REFRESH_TOKEN = 'refresh_token';

    public function __construct(
        public string $type,
        public string $id,
        public string $clientId,
        public string $accessTokenId,
    ) {
    }
}
