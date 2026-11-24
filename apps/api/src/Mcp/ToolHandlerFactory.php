<?php

declare(strict_types=1);

namespace App\Mcp;

use App\Activity\ToolActivity;
use App\Mcp\Tool\Tool;

final readonly class ToolHandlerFactory
{
    public function __construct(
        private ToolAccess $access,
        private Api $api,
        private ToolActivity $activity,
    ) {
    }

    public function for(Tool $tool): ToolHandler
    {
        return new ToolHandler($tool, $this->access, $this->api, $this->activity);
    }
}
