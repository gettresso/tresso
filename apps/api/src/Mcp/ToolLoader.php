<?php

declare(strict_types=1);

namespace App\Mcp;

use Mcp\Capability\Registry\Loader\ExplicitElementLoader;
use Mcp\Capability\Registry\Loader\LoaderInterface;
use Mcp\Capability\RegistryInterface;

/**
 * Registers every tool of the {@see ToolCatalog} with the MCP server (picked up by the bundle as an `mcp.loader`).
 */
final readonly class ToolLoader implements LoaderInterface
{
    public function __construct(
        private ToolCatalog $catalog,
        private ToolHandlerFactory $handlers,
    ) {
    }

    public function load(RegistryInterface $registry): void
    {
        $tools = [];
        foreach ($this->catalog->all() as $tool) {
            $tools[] = ['definition' => ToolCatalog::definition($tool), 'handler' => $this->handlers->for($tool)];
        }

        new ExplicitElementLoader($tools)->load($registry);
    }
}
