<?php

declare(strict_types=1);

namespace App\Mcp;

use App\Mcp\Tool\Tool;
use App\Mcp\Tool\ToolProvider;
use Mcp\Schema\Tool as McpToolDefinition;
use Symfony\Component\DependencyInjection\Attribute\AutowireIterator;

/**
 * Every MCP tool, from every {@see ToolProvider}, by name.
 */
final class ToolCatalog
{
    /** @var array<string, Tool>|null */
    private ?array $tools = null;

    /**
     * @param iterable<ToolProvider> $providers
     */
    public function __construct(
        #[AutowireIterator(ToolProvider::TAG)]
        private readonly iterable $providers,
    ) {
    }

    /**
     * @return array<string, Tool>
     */
    public function all(): array
    {
        if (null !== $this->tools) {
            return $this->tools;
        }

        $tools = [];
        foreach ($this->providers as $provider) {
            foreach ($provider->tools() as $tool) {
                if (isset($tools[$tool->name])) {
                    throw new \LogicException(\sprintf('Two MCP tools are named "%s".', $tool->name));
                }
                $tools[$tool->name] = $tool;
            }
        }
        ksort($tools);

        return $this->tools = $tools;
    }

    /** The tool as tools/list describes it. */
    public static function definition(Tool $tool): McpToolDefinition
    {
        $scopes = [] === $tool->scopes
            ? 'Needs no scope.'
            : 'Needs the scope'.(\count($tool->scopes) > 1 ? 's ' : ' ').implode(' and ', array_map(static fn ($scope): string => $scope->value, $tool->scopes)).'.';

        return new McpToolDefinition(
            name: $tool->name,
            title: $tool->title,
            inputSchema: $tool->inputSchema,
            description: $tool->description.' '.$scopes,
            annotations: $tool->effect->annotations($tool->title),
        );
    }
}
