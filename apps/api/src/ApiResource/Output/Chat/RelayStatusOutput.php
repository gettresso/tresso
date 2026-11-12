<?php

declare(strict_types=1);

namespace App\ApiResource\Output\Chat;

/**
 * The answer to the relay's heartbeat: `active`, this desktop relays the account.
 */
final readonly class RelayStatusOutput
{
    public const string ACTIVE = 'active';

    public function __construct(public string $relay = self::ACTIVE)
    {
    }
}
