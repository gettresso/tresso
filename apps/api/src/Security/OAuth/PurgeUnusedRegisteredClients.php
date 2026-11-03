<?php

declare(strict_types=1);

namespace App\Security\OAuth;

/**
 * Deletes registered clients that never got a token within 30 days of registering.
 */
final readonly class PurgeUnusedRegisteredClients
{
}
