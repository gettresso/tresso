<?php

declare(strict_types=1);

namespace App\Tests\Functional\Mcp;

use App\Tests\Functional\AuthenticatesUsers;
use App\Tests\Functional\ConnectsThirdPartyApps;
use App\Tests\Functional\DatabaseTestCase;

/**
 * An MCP client that knows nothing but the address of /mcp finds its way in, as Claude Code and Claude.ai do: the 401
 * names the protected resource metadata, that names the authorization server, whose metadata gives the registration,
 * authorization and token endpoints; the user allows the app and its token works on /mcp.
 */
final class McpSignInFlowTest extends DatabaseTestCase
{
    use AuthenticatesUsers;
    use ConnectsThirdPartyApps;
    use TalksMcp;

    /** Where Claude Code waits for the code: a port on this computer it picks itself. */
    private const string CLAUDE_CODE_REDIRECT = 'http://localhost:53682/callback';

    /** Claude.ai's custom connectors. */
    private const string CLAUDE_AI_REDIRECT = 'https://claude.ai/api/mcp/auth_callback';

    protected function setUp(): void
    {
        parent::setUp();
        $this->bootstrapOAuthClients();
        $this->createUser('kim@example.test', 'Kim Visser');
        $this->resetRegistrationLimits();
    }

    public function testAnMcpClientSignsInByItself(): void
    {
        $this->mcpPost([], ['jsonrpc' => '2.0', 'id' => 1, 'method' => 'initialize']);
        self::assertResponseStatusCodeSame(401);
        self::assertSame(1, preg_match('/resource_metadata="([^"]+)"/', (string) $this->client->getResponse()->headers->get('WWW-Authenticate'), $match));

        $this->client->request('GET', self::asString($match[1] ?? null));
        self::assertResponseIsSuccessful();
        $resource = $this->responseString('resource');
        $issuer = self::asString(self::asArray($this->decodedResponse()['authorization_servers'] ?? null)[0] ?? null);
        self::assertSame('http://localhost/mcp', $resource);

        $this->client->request('GET', $issuer.'/.well-known/oauth-authorization-server');
        self::assertResponseIsSuccessful();
        $server = $this->decodedResponse();
        self::assertContains('S256', self::asArray($server['code_challenge_methods_supported'] ?? null));
        self::assertContains('settings:write', self::asArray($server['scopes_supported'] ?? null));
        $registrationEndpoint = self::asString($server['registration_endpoint'] ?? null);
        $authorizationEndpoint = self::asString($server['authorization_endpoint'] ?? null);
        $tokenEndpoint = self::asString($server['token_endpoint'] ?? null);

        $this->client->jsonRequest('POST', $registrationEndpoint, [
            'client_name' => 'Claude Code',
            'redirect_uris' => [self::CLAUDE_CODE_REDIRECT],
            'grant_types' => ['authorization_code', 'refresh_token'],
            'response_types' => ['code'],
            'token_endpoint_auth_method' => 'none',
        ]);
        self::assertResponseStatusCodeSame(201);
        $clientId = $this->responseString('client_id');

        $verifier = bin2hex(random_bytes(32));
        $this->client->getCookieJar()->clear();
        $crawler = $this->client->request('GET', '/login');
        $this->client->submit($crawler->selectButton('Sign in')->form(['_username' => 'kim@example.test', '_password' => self::DEFAULT_PASSWORD]));
        $crawler = $this->client->request('GET', $authorizationEndpoint.'?'.http_build_query([
            'response_type' => 'code',
            'client_id' => $clientId,
            'redirect_uri' => self::CLAUDE_CODE_REDIRECT,
            'scope' => 'settings:read settings:write signatures:read signatures:write',
            'state' => 'claude-state',
            'resource' => $resource,
            'code_challenge' => rtrim(strtr(base64_encode(hash('sha256', $verifier, true)), '+/', '-_'), '='),
            'code_challenge_method' => 'S256',
        ]));
        self::assertResponseIsSuccessful('The consent screen is shown.');
        self::assertStringContainsString('Claude Code', $crawler->text());
        $this->client->submit($crawler->selectButton('Allow')->form());

        $location = (string) $this->client->getResponse()->headers->get('Location');
        self::assertStringStartsWith(self::CLAUDE_CODE_REDIRECT.'?', $location);
        parse_str((string) parse_url($location, \PHP_URL_QUERY), $query);
        self::assertSame('claude-state', $query['state'] ?? null);
        self::assertIsString($query['code'] ?? null);

        $this->client->getCookieJar()->clear();
        $this->client->request('POST', $tokenEndpoint, [
            'grant_type' => 'authorization_code',
            'client_id' => $clientId,
            'redirect_uri' => self::CLAUDE_CODE_REDIRECT,
            'code' => $query['code'],
            'code_verifier' => $verifier,
            'resource' => $resource,
        ]);
        self::assertResponseIsSuccessful();
        $headers = ['HTTP_AUTHORIZATION' => 'Bearer '.$this->responseString('access_token')];

        $session = $this->mcpInitialize($headers);
        self::assertContains('set_default_signature', $this->mcpToolNames($headers, $session));
        self::assertSame('kim@example.test', $this->mcpCallOk($headers, $session, 'get_me')['email'] ?? null);
        $created = $this->mcpCallOk($headers, $session, 'create_signature', ['name' => 'From Claude', 'html' => '<p>Kim</p>']);
        self::assertSame('From Claude', $this->connection()->fetchOne('SELECT name FROM signature WHERE id = ?', [$created['id'] ?? null]));
    }

    public function testClaudeAiCanRegisterItsConnector(): void
    {
        $this->client->jsonRequest('POST', '/oauth/register', [
            'client_name' => 'Claude',
            'redirect_uris' => [self::CLAUDE_AI_REDIRECT],
            'grant_types' => ['authorization_code', 'refresh_token'],
            'response_types' => ['code'],
            'token_endpoint_auth_method' => 'none',
        ]);

        self::assertResponseStatusCodeSame(201);
        self::assertSame([self::CLAUDE_AI_REDIRECT], $this->decodedResponse()['redirect_uris'] ?? null);
    }
}
