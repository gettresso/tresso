<?php

declare(strict_types=1);

namespace App\Mcp;

use App\Mcp\Tool\Tool;
use App\Mcp\Tool\ToolArguments;
use App\Security\Scope;
use Mcp\Schema\Content\TextContent;
use Mcp\Schema\Result\CallToolResult;
use Mcp\Server\ClientGateway;
use Mcp\Server\Handler\ToolHandlerInterface;

/**
 * Runs one tool for tools/call. A token without the tool's scopes gets a tool error that names them; a refusal of the
 * API (validation, not found, not allowed) comes back as a tool error in the API's words, so the model can correct
 * itself. What the API answered is the result, as JSON text and as structured content (a list under `items`).
 */
final readonly class ToolHandler implements ToolHandlerInterface
{
    public function __construct(
        private Tool $tool,
        private ToolAccess $access,
        private Api $api,
    ) {
    }

    public function execute(array $arguments, ClientGateway $gateway): CallToolResult
    {
        $missing = $this->access->missingScopes($this->tool);
        if ([] !== $missing) {
            return self::error(\sprintf(
                'Not allowed: %s needs the scope%s %s, which this connection was not given. Connect again and allow it to use this tool.',
                $this->tool->name,
                \count($missing) > 1 ? 's' : '',
                implode(' and ', array_map(static fn (Scope $scope): string => $scope->value, $missing)),
            ));
        }

        try {
            $result = $this->tool->run(new ToolArguments($arguments), $this->api);
        } catch (ApiRefusal $refusal) {
            return self::error($refusal->explain());
        }

        $structured = array_is_list($result) ? ['items' => $result] : $result;

        return new CallToolResult(
            [new TextContent(json_encode($structured, \JSON_THROW_ON_ERROR | \JSON_UNESCAPED_SLASHES | \JSON_UNESCAPED_UNICODE | \JSON_PRESERVE_ZERO_FRACTION))],
            structuredContent: $structured,
        );
    }

    private static function error(string $message): CallToolResult
    {
        return CallToolResult::error([new TextContent($message)]);
    }
}
