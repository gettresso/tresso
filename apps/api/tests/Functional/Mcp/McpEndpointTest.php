<?php

declare(strict_types=1);

namespace App\Tests\Functional\Mcp;

use App\Mcp\ToolCatalog;
use App\Security\Scope;
use App\Tests\Functional\AuthenticatesUsers;
use App\Tests\Functional\ConnectsThirdPartyApps;
use App\Tests\Functional\DatabaseTestCase;
use App\Tests\Support\FailingApiController;
use PHPUnit\Framework\Attributes\DataProvider;
use Symfony\Component\Uid\Uuid;

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

        foreach ($tools as $tool) {
            $name = self::asString($tool['name'] ?? null);
            if ('probe_api_operation' === $name) {
                continue; // tests/Support/McpProbeTools, only in the test environment
            }
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

    public function testWhatOnlyOurOwnAppsMayDoIsRefusedToTheSubRequestsOfATool(): void
    {
        $web = $this->userHeaders('kim@example.test', ['settings:read', 'settings:write', 'mail:read']);
        $this->client->jsonRequest('POST', '/api/v1/mail-accounts', self::account('kim@company.example'), $web);
        self::assertResponseStatusCodeSame(201);
        $account = $this->responseString('id');

        $operations = [
            ['GET', '/personal-access-tokens', null],
            ['POST', '/personal-access-tokens', ['name' => 'Sneaky', 'scopes' => ['settings:read']]],
            ['GET', '/connected-apps', null],
            ['GET', '/billing', null],
            ['POST', '/billing/checkout', ['organizationId' => '0193a1b2-c3d4-7e5f-8a9b-0c1d2e3f4a5b', 'plan' => 'monthly']],
            ['POST', '/provider-authorizations', ['provider' => 'google', 'emailAddress' => 'kim@gmail.example']],
            ['POST', '/provider-connections', ['provider' => 'google', 'state' => 'a-state', 'code' => 'a-code']],
            ['POST', '/mail-accounts', self::account('kim@other.example')],
            ['PATCH', '/mail-accounts/'.$account, ['password' => 'stolen-elsewhere']],
            ['DELETE', '/mail-accounts/'.$account, null],
            ['POST', '/notification-devices', ['kind' => 'expo', 'endpoint' => 'ExponentPushToken[sneaky]', 'name' => 'Sneaky']],
            ['GET', '/realtime/token', null],
        ];

        foreach ([
            'personal access token' => $this->personalAccessTokenHeaders('kim@example.test', ['settings:read', 'settings:write', 'mail:read']),
            'third-party app' => $this->thirdPartyHeaders('kim@example.test', ['settings:read', 'settings:write', 'mail:read']),
        ] as $caller => $headers) {
            $session = $this->mcpInitialize($headers);
            foreach ($operations as [$method, $path, $body]) {
                $error = $this->mcpCallError($headers, $session, 'probe_api_operation', ['method' => $method, 'path' => $path] + (null === $body ? [] : ['body' => $body]));
                self::assertStringStartsWith('Not allowed:', $error, \sprintf('%s %s for a %s', $method, $path, $caller));
            }
        }

        self::assertSame(1, $this->countRows('SELECT COUNT(*) FROM personal_access_token'), 'Only the token of this test exists.');
        self::assertSame(1, $this->countRows('SELECT COUNT(*) FROM mail_account'));
        self::assertSame(0, $this->countRows('SELECT COUNT(*) FROM notification_device'));

        $session = $this->mcpInitialize($web);
        self::assertCount(1, self::asList($this->mcpCallOk($web, $session, 'probe_api_operation', ['method' => 'GET', 'path' => '/personal-access-tokens'])), 'Our own app may, also through a tool.');
    }

    public function testRevokingTheTokenEndsTheConnectionAtOnce(): void
    {
        $headers = $this->personalAccessTokenHeaders('kim@example.test', ['settings:read']);
        $tokenId = $this->responseString('id');
        $session = $this->mcpInitialize($headers);

        $this->client->request('DELETE', '/api/v1/personal-access-tokens/'.$tokenId, server: $this->userHeaders('kim@example.test', ['settings:write']));
        self::assertResponseStatusCodeSame(204);

        $this->mcpPost($headers, ['jsonrpc' => '2.0', 'id' => 5, 'method' => 'tools/list'], $session);
        self::assertResponseStatusCodeSame(401);
        self::assertStringContainsString('error="invalid_token"', (string) $this->client->getResponse()->headers->get('WWW-Authenticate'));
    }

    public function testDisconnectingTheAppEndsTheConnectionAtOnce(): void
    {
        $headers = $this->thirdPartyHeaders('kim@example.test', ['settings:read']);
        $session = $this->mcpInitialize($headers);
        $this->mcpCallOk($headers, $session, 'get_me');

        $web = $this->userHeaders('kim@example.test', ['settings:read', 'settings:write']);
        $this->client->request('GET', '/api/v1/connected-apps', server: $web);
        $app = self::asString(self::asList($this->decodedResponse())[0]['id'] ?? null);
        $this->client->request('DELETE', '/api/v1/connected-apps/'.$app, server: $web);
        self::assertResponseStatusCodeSame(204);

        $this->mcpPost($headers, ['jsonrpc' => '2.0', 'id' => 5, 'method' => 'tools/call', 'params' => ['name' => 'get_me', 'arguments' => new \stdClass()]], $session);
        self::assertResponseStatusCodeSame(401);
        self::assertStringContainsString('error="invalid_token"', (string) $this->client->getResponse()->headers->get('WWW-Authenticate'));
    }

    public function testAFailureOfTheServerIsReportedWithoutItsDetails(): void
    {
        $headers = $this->personalAccessTokenHeaders('kim@example.test', ['settings:read']);
        $session = $this->mcpInitialize($headers);

        $message = $this->mcpRequest($headers, $session, 'tools/call', ['name' => 'probe_api_operation', 'arguments' => ['method' => 'GET', 'path' => '/test-failure']]);

        self::assertSame(['code' => -32603, 'message' => 'Error while executing tool'], self::asArray($message['error'] ?? null));
        self::assertStringNotContainsString('hunter2', (string) $this->client->getResponse()->getContent());
        self::assertStringNotContainsString(FailingApiController::SECRET, (string) $this->client->getResponse()->getContent());
    }

    public function testThereAreNoPrompts(): void
    {
        $headers = $this->personalAccessTokenHeaders('kim@example.test', ['settings:read']);
        $session = $this->mcpInitialize($headers);

        self::assertSame([], self::asArray($this->mcpRequest($headers, $session, 'prompts/list')['result'] ?? null)['prompts'] ?? null);
    }

    #[DataProvider('sessionIdsInOtherForms')]
    public function testAnotherUsersSessionIsRefusedInEveryWayAnIdCanBeWritten(string $form): void
    {
        $kim = $this->personalAccessTokenHeaders('kim@example.test', ['settings:read']);
        $session = $this->mcpInitialize($kim);
        $lisa = $this->personalAccessTokenHeaders('lisa@example.test', ['settings:read']);
        $written = match ($form) {
            'base58' => Uuid::fromString($session)->toBase58(),
            'base32' => Uuid::fromString($session)->toBase32(),
            'uppercase' => strtoupper($session),
            default => throw new \LogicException($form),
        };

        $this->mcpPost($lisa, ['jsonrpc' => '2.0', 'id' => 9, 'method' => 'tools/list'], $written);
        self::assertResponseStatusCodeSame(404, 'Reading another user\'s session.');

        $this->client->request('DELETE', '/mcp', server: $lisa + ['HTTP_MCP_SESSION_ID' => $written, 'HTTP_MCP_PROTOCOL_VERSION' => self::MCP_PROTOCOL]);
        self::assertResponseStatusCodeSame(404, 'Ending another user\'s session.');

        $this->mcpRequest($kim, $session, 'tools/list');
        self::assertResponseIsSuccessful('Kim\'s session still works.');
    }

    /**
     * @return iterable<string, array{string}>
     */
    public static function sessionIdsInOtherForms(): iterable
    {
        yield 'base58' => ['base58'];
        yield 'base32' => ['base32'];
        yield 'uppercase' => ['uppercase'];
    }

    public function testASessionIdNotWrittenAsAUuidIsNoSession(): void
    {
        $kim = $this->personalAccessTokenHeaders('kim@example.test', ['settings:read']);
        $session = $this->mcpInitialize($kim);

        $this->mcpPost($kim, ['jsonrpc' => '2.0', 'id' => 9, 'method' => 'tools/list'], Uuid::fromString($session)->toBase58());

        self::assertResponseStatusCodeSame(404, 'Only the form the server hands out names a session, also for its owner.');
    }

    /**
     * @return array<string, mixed>
     */
    private static function account(string $emailAddress): array
    {
        return [
            'emailAddress' => $emailAddress,
            'displayName' => $emailAddress,
            'username' => $emailAddress,
            'password' => 'app-password-1',
            'imap' => ['host' => 'imap.company.example', 'port' => 993, 'security' => 'tls'],
            'smtp' => ['host' => 'smtp.company.example', 'port' => 465, 'security' => 'tls'],
        ];
    }
}
