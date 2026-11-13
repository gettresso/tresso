<?php

declare(strict_types=1);

namespace App\Mcp\Tool;

use Mcp\Schema\ToolAnnotations;

/**
 * What a tool does to the user's data, for the MCP tool annotations a client uses to decide what to confirm first.
 * Every tool acts on Tresso only, except {@see self::Send}, which reaches other people.
 */
enum ToolEffect
{
    /** Reads only. */
    case Read;
    /** Adds something new; calling it twice adds two. */
    case Create;
    /** Changes what is there; calling it again with the same input changes nothing more. */
    case Update;
    /** Deletes or switches something off for good. */
    case Delete;
    /**
     * Sends something to other people in the user's name; calling it twice sends twice. Marked destructive, since it
     * cannot be taken back, so a client that asks before such tools asks the user.
     */
    case Send;

    public function annotations(string $title): ToolAnnotations
    {
        return match ($this) {
            self::Read => new ToolAnnotations($title, readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false),
            self::Create => new ToolAnnotations($title, readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: false),
            self::Update => new ToolAnnotations($title, readOnlyHint: false, destructiveHint: false, idempotentHint: true, openWorldHint: false),
            self::Delete => new ToolAnnotations($title, readOnlyHint: false, destructiveHint: true, idempotentHint: true, openWorldHint: false),
            self::Send => new ToolAnnotations($title, readOnlyHint: false, destructiveHint: true, idempotentHint: false, openWorldHint: true),
        };
    }
}
