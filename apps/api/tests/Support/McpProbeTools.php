<?php

declare(strict_types=1);

namespace App\Tests\Support;

use App\Mcp\Api;
use App\Mcp\Tool\Tool;
use App\Mcp\Tool\ToolArguments;
use App\Mcp\Tool\ToolEffect;
use App\Mcp\Tool\ToolProvider;

/**
 * Test only (registered under when@test): a tool that runs any API operation through {@see Api}, the way every real
 * tool does. It shows that the sub-requests of a tool get exactly what the token gets over REST, so that operations only
 * Tresso's own apps may use are refused to personal access tokens and third-party apps whatever tool would ask.
 */
final readonly class McpProbeTools implements ToolProvider
{
    public function tools(): iterable
    {
        yield new Tool(
            name: 'probe_api_operation',
            title: 'Run an API operation (tests only)',
            description: 'Runs one API operation as a tool would.',
            scopes: [],
            effect: ToolEffect::Update,
            inputSchema: [
                'type' => 'object',
                'properties' => [
                    'method' => ['type' => 'string', 'enum' => ['GET', 'POST', 'PATCH', 'PUT', 'DELETE']],
                    'path' => ['type' => 'string'],
                    'body' => ['type' => 'object'],
                ],
                'required' => ['method', 'path'],
                'additionalProperties' => false,
            ],
            run: static function (ToolArguments $arguments, Api $api): array {
                $path = $arguments->string('path');
                $body = $arguments->get('body');
                /** @var array<string, mixed> $body */
                $body = \is_array($body) ? $body : [];

                return match ($arguments->string('method')) {
                    'GET' => $api->get($path),
                    'POST' => $api->post($path, $body),
                    'PATCH' => $api->patch($path, $body),
                    'PUT' => $api->put($path, $body),
                    default => $api->delete($path),
                };
            },
        );
    }
}
