<?php

declare(strict_types=1);

namespace App\Activity;

/** How an action came in: a tool call on the MCP endpoint, or a request to the API. */
enum ActivityChannel: string
{
    case Mcp = 'mcp';
    case Api = 'api';

    public function label(): string
    {
        return match ($this) {
            self::Mcp => 'MCP',
            self::Api => 'API',
        };
    }
}
