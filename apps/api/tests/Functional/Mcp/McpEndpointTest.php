<?php

declare(strict_types=1);

namespace App\Tests\Functional\Mcp;

use App\Mcp\ToolCatalog;
use App\Security\Scope;
use App\Tests\Functional\AuthenticatesUsers;
use App\Tests\Functional\ConnectsThirdPartyApps;
use App\Tests\Functional\DatabaseTestCase;

/**
 * The MCP endpoint itself: who may connect, how a client is told to sign in, which tools each token sees and that a
 * tool never does more than its scopes allow.
 */
final class McpEndpointTest extends DatabaseTestCase
{
    use AuthenticatesUsers;
    use ConnectsThirdPartyApps;
    use TalksMcp;

    private const string METADATA_URL = 'http://localhost/.well-known/oauth-protected-resource/mcp';

    /** What only Tresso's own apps may do; never a tool. */
    private const array FIRST_PARTY_ONLY = [
        'create_mail_account', 'delete_mail_account', 'add_mail_account', 'remove_mail_account',
        'get_mail_server_settings', 'register_notification_device', 'create_notification_device',
        'list_personal_access_tokens', 'create_personal_access_token', 'revoke_personal_access_token',
        'list_connected_apps', 'disconnect_connected_app', 'get_billing', 'start_billing_checkout',
        'get_realtime_token', 'start_provider_authorization',
    ];

    protected function setUp(): void
    {
        parent::setUp();
        $this->bootstrapOAuthClients();
        $this->createUser('kim@example.test', 'Kim Visser');
        $this->createUser('lisa@example.test', 'Lisa Bakker');
    }

    public function testWithoutATokenTheClientIsSentToTheMetadata(): void
    {
        $this->mcpPost(['HTTP_ACCEPT' => 'application/json'], ['jsonrpc' => '2.0', 'id' => 1, 'method' => 'initialize']);

        self::assertResponseStatusCodeSame(401);
        self::assertSame(\sprintf('Bearer resource_metadata="%s"', self::METADATA_URL), $this->client->getResponse()->headers->get('WWW-Authenticate'));

        $this->client->request('GET', self::METADATA_URL);
        self::assertResponseIsSuccessful();
        self::assertSame('http://localhost/mcp', $this->decodedResponse()['resource'] ?? null);
    }

    public function testARefusedTokenGetsInvalidToken(): void
    {
        foreach (['Bearer not-a-token', 'Bearer tresso_pat_'.str_repeat('A', 43)] as $authorization) {
            $this->mcpPost(['HTTP_AUTHORIZATION' => $authorization], ['jsonrpc' => '2.0', 'id' => 1, 'method' => 'initialize']);

            self::assertResponseStatusCodeSame(401);
            $challenge = (string) $this->client->getResponse()->headers->get('WWW-Authenticate');
            self::assertStringStartsWith(\sprintf('Bearer resource_metadata="%s", error="invalid_token"', self::METADATA_URL), $challenge);
        }
    }

    public function testASyncWorkerCannotConnect(): void
    {
        $this->mcpPost($this->workerHeaders('sync:lease'), ['jsonrpc' => '2.0', 'id' => 1, 'method' => 'initialize']);

        self::assertResponseStatusCodeSame(403);
    }

    public function testOtherHostsAndOriginsAreRefused(): void
    {
        $headers = $this->personalAccessTokenHeaders('kim@example.test', ['settings:read']);

        $this->mcpPost($headers + ['HTTP_HOST' => 'attacker.example'], ['jsonrpc' => '2.0', 'id' => 1, 'method' => 'ping']);
        self::assertResponseStatusCodeSame(403);
        self::assertStringContainsString('Host', (string) $this->client->getResponse()->getContent());

        $this->mcpPost($headers + ['HTTP_HOST' => 'localhost', 'HTTP_ORIGIN' => 'https://attacker.example'], ['jsonrpc' => '2.0', 'id' => 1, 'method' => 'ping']);
        self::assertResponseStatusCodeSame(403);
        self::assertStringContainsString('Origin', (string) $this->client->getResponse()->getContent());
    }

    public function testAPersonalAccessTokenSeesTheToolsOfItsScopes(): void
    {
        $headers = $this->personalAccessTokenHeaders('kim@example.test', ['signatures:read']);
        $session = $this->mcpInitialize($headers);

        self::assertSame(['get_me', 'get_server_info', 'get_signature', 'list_signatures'], $this->mcpToolNames($headers, $session));
    }

    public function testAThirdPartyAppSeesTheToolsOfItsScopes(): void
    {
        $headers = $this->thirdPartyHeaders('kim@example.test', ['settings:read', 'settings:write']);
        $session = $this->mcpInitialize($headers);

        $names = $this->mcpToolNames($headers, $session);
        self::assertContains('update_notification_settings', $names);
        self::assertContains('add_smart_inbox_senders', $names);
        self::assertContains('update_mail_account', $names);
        self::assertNotContains('list_signatures', $names, 'Signatures have scopes of their own.');
        self::assertNotContains('list_calendars', $names);
        self::assertNotContains('get_smart_inbox_senders', $names, 'Who sends mail is mail, behind mail:read.');

        self::assertSame('kim@example.test', $this->mcpCallOk($headers, $session, 'get_me')['email'] ?? null);
    }

    public function testEveryToolIsDescribedAndNothingOnlyOurAppsMayDoIsATool(): void
    {
        $headers = $this->userHeaders('kim@example.test', array_map(static fn (Scope $scope): string => $scope->value, Scope::thirdPartyAppScopes()));
        $session = $this->mcpInitialize($headers);
        $tools = $this->mcpTools($headers, $session);

        $catalog = static::getContainer()->get(ToolCatalog::class);
        $names = array_map(static fn (array $tool): string => self::asString($tool['name'] ?? null), $tools);
        self::assertSame(array_keys($catalog->all()), $names, 'With every scope, every tool is listed.');
        self::assertSame([], array_values(array_intersect(self::FIRST_PARTY_ONLY, $names)));

        foreach ($tools as $tool) {
            $name = self::asString($tool['name'] ?? null);
            $schema = self::asArray($tool['inputSchema'] ?? null);
            $annotations = self::asArray($tool['annotations'] ?? null);
            self::assertMatchesRegularExpression('/^(get|list|create|update|delete|set|add|remove)_[a-z_]+$/', $name);
            self::assertNotEmpty($tool['description'] ?? null, $name);
            self::assertSame('object', $schema['type'] ?? null, $name);
            self::assertFalse($schema['additionalProperties'] ?? true, $name.' refuses fields it does not name.');
            self::assertIsBool($annotations['readOnlyHint'] ?? null, $name);
            self::assertIsBool($annotations['destructiveHint'] ?? null, $name);
            self::assertIsBool($annotations['idempotentHint'] ?? null, $name);
            self::assertSame(str_starts_with($name, 'get_') || str_starts_with($name, 'list_'), $annotations['readOnlyHint'], $name);
            self::assertSame(str_starts_with($name, 'delete_'), $annotations['destructiveHint'], $name);
        }
    }

    public function testAToolOutsideTheScopesIsRefused(): void
    {
        $headers = $this->personalAccessTokenHeaders('kim@example.test', ['signatures:read']);
        $session = $this->mcpInitialize($headers);

        $error = $this->mcpCallError($headers, $session, 'create_signature', ['name' => 'Work', 'html' => '<p>Kim</p>']);

        self::assertStringContainsString('signatures:write', $error);
        self::assertSame(0, $this->countRows('SELECT COUNT(*) FROM signature'));
    }

    public function testFieldsATokenMayNotChangeAreRefused(): void
    {
        $headers = $this->thirdPartyHeaders('kim@example.test', ['settings:read', 'settings:write']);
        $session = $this->mcpInitialize($headers);

        $message = $this->mcpRequest($headers, $session, 'tools/call', ['name' => 'update_mail_account', 'arguments' => [
            'id' => '0193a1b2-c3d4-7e5f-8a9b-0c1d2e3f4a5b',
            'password' => 'something-else',
        ]]);

        self::assertSame(-32602, self::asArray($message['error'] ?? null)['code'] ?? null, 'Fields a tool does not name are refused before anything runs.');
    }

    public function testAnotherUsersSessionIsRefused(): void
    {
        $kim = $this->personalAccessTokenHeaders('kim@example.test', ['settings:read']);
        $session = $this->mcpInitialize($kim);
        $lisa = $this->personalAccessTokenHeaders('lisa@example.test', ['settings:read']);

        $this->mcpPost($lisa, ['jsonrpc' => '2.0', 'id' => 9, 'method' => 'tools/list'], $session);

        self::assertResponseStatusCodeSame(404);
        self::assertStringNotContainsString('get_me', (string) $this->client->getResponse()->getContent());

        $this->mcpRequest($kim, $session, 'tools/list');
        self::assertResponseIsSuccessful('The session still works for the one who started it.');
    }

    public function testTheScopesGuideNamesTheToolsOfEachScope(): void
    {
        $headers = $this->personalAccessTokenHeaders('kim@example.test', ['settings:read']);
        $session = $this->mcpInitialize($headers);

        $resources = self::asList(self::asArray($this->mcpRequest($headers, $session, 'resources/list')['result'] ?? null)['resources'] ?? null);
        self::assertSame(['tresso://scopes'], array_column($resources, 'uri'));

        $contents = self::asList(self::asArray($this->mcpRequest($headers, $session, 'resources/read', ['uri' => 'tresso://scopes'])['result'] ?? null)['contents'] ?? null);
        $text = self::asString($contents[0]['text'] ?? null);
        self::assertStringContainsString('## signatures:write (Change signatures)', $text);
        self::assertStringContainsString('set_default_signature', $text);
    }
}
