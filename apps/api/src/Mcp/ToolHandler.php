<?php

declare(strict_types=1);

namespace App\Mcp;

use App\Activity\ActivityReason;
use App\Activity\ToolActivity;
use App\Mcp\Tool\Tool;
use App\Mcp\Tool\ToolArguments;
use App\Security\Scope;
use Mcp\Exception\ToolCallException;
use Mcp\Schema\Content\TextContent;
use Mcp\Schema\Result\CallToolResult;
use Mcp\Server\ClientGateway;
use Mcp\Server\Handler\ToolHandlerInterface;

/**
 * Runs one tool for tools/call. A token without the tool's scopes gets a tool error that names them; a refusal of the
 * API (validation, not found, not allowed) comes back as a tool error in the API's words, so the model can correct
 * itself. What the API answered is the result, as JSON text and as structured content (a list under `items`).
 *
 * Every call of an app that is not ours goes into the activity log ({@see ToolActivity}), refusals and failures too.
 */
final readonly class ToolHandler implements ToolHandlerInterface
{
    public function __construct(
        private Tool $tool,
        private ToolAccess $access,
        private Api $api,
        private ToolActivity $activity,
    ) {
    }

    public function execute(array $arguments, ClientGateway $gateway): CallToolResult
    {
        $started = $this->activity->start();
        $missing = $this->access->missingScopes($this->tool);
        if ([] !== $missing) {
            $names = implode(' and ', array_map(static fn (Scope $scope): string => $scope->value, $missing));
            $chat = [] !== array_filter($missing, static fn (Scope $scope): bool => $scope->isChat());
            $this->activity->finish($started, $this->tool, ActivityReason::NoPermission);

            if ($this->access->allSwitchedOff($missing)) {
                return self::error(\sprintf(
                    'Not allowed: %s needs the scope%s %s, which the user switched off for this app in Tresso (Settings, Apps, AI assistants). Only the user can switch it on again there.',
                    $this->tool->name,
                    \count($missing) > 1 ? 's' : '',
                    $names,
                ));
            }

            return self::error(\sprintf(
                'Not allowed: %s needs the scope%s %s, which this connection was not given. %s',
                $this->tool->name,
                \count($missing) > 1 ? 's' : '',
                $names,
                $chat
                    ? \sprintf('WhatsApp is a permission of its own: the app has to register again naming %s and the user has to tick it when allowing the app, or the connection can use a personal access token with %s ticked.', $names, $names)
                    : 'Connect again and allow it to use this tool.',
            ));
        }

        try {
            $result = $this->tool->run(new ToolArguments($arguments), $this->api);
        } catch (ApiRefusal $refusal) {
            $this->activity->finish($started, $this->tool, ActivityReason::ofStatus($refusal->status) ?? ActivityReason::NotAccepted);

            return self::error($refusal->explain());
        } catch (ToolCallException $exception) {
            // Arguments the tool could not use: the SDK answers with a tool error.
            $this->activity->finish($started, $this->tool, ActivityReason::NotAccepted);

            throw $exception;
        } catch (\Throwable $exception) {
            $this->activity->finish($started, $this->tool, ToolActivity::failureOf($exception));

            throw $exception;
        }
        $this->activity->finish($started, $this->tool, null);

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
