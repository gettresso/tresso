<?php

declare(strict_types=1);

namespace App\Chat;

/** Every minute: mark relays that went silent offline, and fail replies whose send could not be confirmed. */
final readonly class SweepChatRelays
{
}
