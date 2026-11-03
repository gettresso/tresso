<?php

declare(strict_types=1);

namespace App\Security\PersonalAccessToken;

/**
 * Deletes personal access tokens that were revoked or expired long enough ago. Sent by the schedule once a day.
 */
final readonly class PurgeOldPersonalAccessTokens
{
}
