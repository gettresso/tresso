<?php

declare(strict_types=1);

namespace App\Mcp;

use App\Mcp\Tool\Tool;
use App\Security\Scope;
use Mcp\Capability\Attribute\McpResource;

/**
 * A short guide, as an MCP resource: every scope an MCP client can ask for, what it allows and which tools need it, so
 * a model can tell the user which permission is missing. The same for every caller; it holds no user data.
 *
 * It is also the one element the bundle registers from an attribute (`registry` in config/packages/mcp.yaml names this
 * namespace), which keeps the registry to this application's own elements instead of `*`. The tools come from
 * {@see ToolLoader}.
 */
final readonly class ScopesResource
{
    public const string URI = 'tresso://scopes';

    public function __construct(private ToolCatalog $catalog)
    {
    }

    #[McpResource(
        uri: self::URI,
        name: 'scopes',
        title: 'Scopes and tools',
        description: 'What each scope a connection can be given allows, and which tools need it.',
        mimeType: 'text/markdown',
    )]
    public function read(): string
    {
        $lines = ['# Tresso scopes and tools', ''];
        foreach (Scope::thirdPartyAppScopes() as $scope) {
            $tools = array_keys(array_filter($this->catalog->all(), static fn (Tool $tool): bool => \in_array($scope, $tool->scopes, true)));
            $lines[] = \sprintf('## %s (%s)', $scope->value, $scope->label());
            $lines[] = $scope->description();
            if ($scope->isChat()) {
                $lines[] = 'WhatsApp, separate from mail: an app gets it only when it names it when it registers and the user allows it, and a personal access token only when the user ticks it. No other scope includes it.';
            }
            $lines[] = [] === $tools ? 'No tools yet.' : 'Tools: '.implode(', ', $tools).'.';
            $lines[] = '';
        }

        $open = array_keys(array_filter($this->catalog->all(), static fn (Tool $tool): bool => [] === $tool->scopes));
        $lines[] = '## Without a scope';
        $lines[] = 'Tools: '.implode(', ', $open).'.';

        return implode("\n", $lines)."\n";
    }
}
