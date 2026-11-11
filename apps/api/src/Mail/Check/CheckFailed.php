<?php

declare(strict_types=1);

namespace App\Mail\Check;

/**
 * Ends a check: what went wrong, and one technical line for the user (host and port, or what the server said).
 */
final class CheckFailed extends \RuntimeException
{
    public function __construct(public readonly CheckStatus $status, string $detail)
    {
        parent::__construct($detail);
    }
}
