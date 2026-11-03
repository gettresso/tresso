<?php

declare(strict_types=1);

namespace App\Tests\Functional\Mcp;

use Symfony\Bundle\FrameworkBundle\KernelBrowser;

/**
 * Speaks MCP (Streamable HTTP, the handshake era as Claude Code uses it) to /mcp through the test client.
 *
 * @property KernelBrowser $client
 */
trait TalksMcp
{
    private const string MCP_PROTOCOL = '2025-06-18';

    private int $mcpRequestId = 0;

    /**
     * Sends a JSON-RPC message to /mcp as is.
     *
     * @param array<string, string> $headers
     * @param array<string, mixed>  $message
     */
    protected function mcpPost(array $headers, array $message, ?string $session = null): void
    {
        $server = $headers + [
            'CONTENT_TYPE' => 'application/json',
            'HTTP_ACCEPT' => 'application/json, text/event-stream',
        ];
        $server['HTTP_ACCEPT'] = 'application/json, text/event-stream';
        if (null !== $session) {
            $server['HTTP_MCP_SESSION_ID'] = $session;
            $server['HTTP_MCP_PROTOCOL_VERSION'] = self::MCP_PROTOCOL;
        }

        $this->client->request('POST', '/mcp', server: $server, content: json_encode($message, \JSON_THROW_ON_ERROR));
    }

    /**
     * Runs initialize and notifications/initialized; returns the session id.
     *
     * @param array<string, string> $headers
     */
    protected function mcpInitialize(array $headers): string
    {
        $this->mcpPost($headers, [
            'jsonrpc' => '2.0',
            'id' => ++$this->mcpRequestId,
            'method' => 'initialize',
            'params' => [
                'protocolVersion' => self::MCP_PROTOCOL,
                'capabilities' => new \stdClass(),
                'clientInfo' => ['name' => 'tresso-tests', 'version' => '1.0.0'],
            ],
        ]);
        self::assertResponseIsSuccessful((string) $this->client->getResponse()->getContent());
        $session = $this->client->getResponse()->headers->get('Mcp-Session-Id');
        self::assertIsString($session, 'initialize starts a session.');
        $result = self::asArray($this->mcpMessage()['result'] ?? null);
        self::assertSame('tresso', self::asArray($result['serverInfo'] ?? null)['name'] ?? null);

        $this->mcpPost($headers, ['jsonrpc' => '2.0', 'method' => 'notifications/initialized'], $session);
        self::assertResponseStatusCodeSame(202);

        return $session;
    }

    /**
     * Sends a request in the session and returns the JSON-RPC answer.
     *
     * @param array<string, string> $headers
     * @param array<string, mixed>  $params
     *
     * @return array<mixed>
     */
    protected function mcpRequest(array $headers, string $session, string $method, array $params = []): array
    {
        $this->mcpPost($headers, [
            'jsonrpc' => '2.0',
            'id' => ++$this->mcpRequestId,
            'method' => $method,
            'params' => [] === $params ? new \stdClass() : $params,
        ], $session);
        self::assertResponseIsSuccessful((string) $this->client->getResponse()->getContent());

        return $this->mcpMessage();
    }

    /**
     * The tools tools/list answers, as sent.
     *
     * @param array<string, string> $headers
     *
     * @return list<array<mixed>>
     */
    protected function mcpTools(array $headers, string $session): array
    {
        $result = self::asArray($this->mcpRequest($headers, $session, 'tools/list')['result'] ?? null);

        return self::asList($result['tools'] ?? null);
    }

    /**
     * @param array<string, string> $headers
     *
     * @return list<string>
     */
    protected function mcpToolNames(array $headers, string $session): array
    {
        return array_map(static fn (array $tool): string => self::asString($tool['name'] ?? null), $this->mcpTools($headers, $session));
    }

    /**
     * Calls a tool and returns its result (content, structuredContent, isError).
     *
     * @param array<string, string> $headers
     * @param array<string, mixed>  $arguments
     *
     * @return array<mixed>
     */
    protected function mcpCall(array $headers, string $session, string $tool, array $arguments = []): array
    {
        $message = $this->mcpRequest($headers, $session, 'tools/call', ['name' => $tool, 'arguments' => [] === $arguments ? new \stdClass() : $arguments]);
        $result = $message['result'] ?? null;
        self::assertIsArray($result, \sprintf('tools/call %s answered no result: %s', $tool, json_encode($message)));

        return $result;
    }

    /**
     * Calls a tool that must succeed and returns its structured content.
     *
     * @param array<string, string> $headers
     * @param array<string, mixed>  $arguments
     *
     * @return array<mixed>
     */
    protected function mcpCallOk(array $headers, string $session, string $tool, array $arguments = []): array
    {
        $result = $this->mcpCall($headers, $session, $tool, $arguments);
        self::assertFalse($result['isError'] ?? false, \sprintf('%s failed: %s', $tool, $this->mcpText($result)));
        $structured = $result['structuredContent'] ?? null;
        self::assertIsArray($structured);
        self::assertSame($structured, json_decode($this->mcpText($result), true), 'The text content is the structured content as JSON.');

        return $structured;
    }

    /**
     * Calls a tool that must fail and returns its error text.
     *
     * @param array<string, string> $headers
     * @param array<string, mixed>  $arguments
     */
    protected function mcpCallError(array $headers, string $session, string $tool, array $arguments = []): string
    {
        $result = $this->mcpCall($headers, $session, $tool, $arguments);
        self::assertTrue($result['isError'] ?? false, \sprintf('%s should have failed.', $tool));

        return $this->mcpText($result);
    }

    /**
     * @param array<mixed> $result
     */
    protected function mcpText(array $result): string
    {
        return self::asString(self::asList($result['content'] ?? null)[0]['text'] ?? null);
    }

    /**
     * The objects of a list a tool answered (under `items`) or that sits at a key of an answer.
     *
     * @return list<array<mixed>>
     */
    protected static function asList(mixed $value): array
    {
        if (\is_array($value) && \array_key_exists('items', $value)) {
            $value = $value['items'];
        }
        self::assertIsArray($value);
        self::assertTrue(array_is_list($value), 'A list.');
        $list = [];
        foreach ($value as $item) {
            self::assertIsArray($item);
            $list[] = $item;
        }

        return $list;
    }

    /**
     * @return array<mixed>
     */
    protected static function asArray(mixed $value): array
    {
        self::assertIsArray($value);

        return $value;
    }

    protected static function asString(mixed $value): string
    {
        self::assertIsString($value);

        return $value;
    }

    /**
     * The JSON-RPC message of the last response, sent as JSON or as one server-sent event.
     *
     * @return array<mixed>
     */
    protected function mcpMessage(): array
    {
        $response = $this->client->getResponse();
        $body = (string) $response->getContent();
        if (str_starts_with((string) $response->headers->get('Content-Type'), 'text/event-stream')) {
            preg_match_all('/^data: ?(.*)$/m', $body, $matches);
            $body = (string) end($matches[1]);
        }

        $message = json_decode($body, true, flags: \JSON_THROW_ON_ERROR);
        self::assertIsArray($message);

        return $message;
    }
}
