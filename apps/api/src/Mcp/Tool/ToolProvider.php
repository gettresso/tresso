<?php

declare(strict_types=1);

namespace App\Mcp\Tool;

use Symfony\Component\DependencyInjection\Attribute\AutoconfigureTag;

/**
 * A group of MCP tools, usually those of one API resource. Every service implementing this is picked up by
 * {@see \App\Mcp\ToolCatalog}; adding tools for another part of the API (mail, todos, events) is adding a provider.
 */
#[AutoconfigureTag(self::TAG)]
interface ToolProvider
{
    public const string TAG = 'app.mcp_tool_provider';

    /**
     * @return iterable<Tool>
     */
    public function tools(): iterable;
}
