<?php

declare(strict_types=1);

namespace App\Mcp\Tool;

use App\Mcp\Api;
use App\Security\Scope;

/**
 * One MCP tool: what a client sees in tools/list and what it runs. A tool calls the API operations it stands for
 * through {@see Api}, never anything else, and is only offered to a token that has every one of its scopes; the API
 * checks them again on every call.
 */
final readonly class Tool
{
    /** snake_case, starting with a verb: list_signatures, update_smart_inbox. */
    private const string NAME = '/^[a-z]+(_[a-z]+)+$/';

    /**
     * @param list<Scope>                                         $scopes      every scope the tool needs
     * @param array<string, mixed>                                $inputSchema a JSON Schema of type object
     * @param \Closure(ToolArguments, Api): array<mixed>           $run         answers what the API answered
     */
    public function __construct(
        public string $name,
        public string $title,
        public string $description,
        public array $scopes,
        public ToolEffect $effect,
        public array $inputSchema,
        private \Closure $run,
    ) {
        if (1 !== preg_match(self::NAME, $name)) {
            throw new \InvalidArgumentException(\sprintf('The MCP tool name "%s" is not snake_case with a verb first.', $name));
        }
        if ('object' !== ($inputSchema['type'] ?? null)) {
            throw new \InvalidArgumentException(\sprintf('The input schema of MCP tool "%s" is not an object.', $name));
        }
    }

    /**
     * @return array<mixed>
     */
    public function run(ToolArguments $arguments, Api $api): array
    {
        return ($this->run)($arguments, $api);
    }
}
