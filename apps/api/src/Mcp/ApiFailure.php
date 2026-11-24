<?php

declare(strict_types=1);

namespace App\Mcp;

/**
 * The API failed what a tool asked (a 5xx): a failure of ours, thrown as such. The status tells the activity log
 * whether something did not answer (502, 503, 504) or the request itself failed.
 */
final class ApiFailure extends \RuntimeException
{
    public function __construct(public readonly int $status, string $message)
    {
        parent::__construct($message);
    }
}
