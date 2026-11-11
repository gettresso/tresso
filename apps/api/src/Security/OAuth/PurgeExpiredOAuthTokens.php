<?php

declare(strict_types=1);

namespace App\Security\OAuth;

/**
 * Deletes expired OAuth2 refresh tokens, access tokens and authorization codes. Sent by the schedule once a day.
 */
final readonly class PurgeExpiredOAuthTokens
{
}
