<?php

declare(strict_types=1);

namespace App\Tests\Functional;

use App\Security\OAuth\ProtectedResources;
use App\Tests\Functional\Mcp\TalksMcp;

/**
 * The sign-in pages on a host of their own (AUTH_PUBLIC_URL) and the MCP endpoint on a host of its own
 * (MCP_PUBLIC_URL), next to the API host; and that a server that sets neither behaves as before.
 */
final class PublicHostsTest extends DatabaseTestCase
{
    use AuthenticatesUsers;
    use TalksMcp;

    private const array SETTINGS = ['AUTH_PUBLIC_URL', 'MCP_PUBLIC_URL', 'MCP_ON_API_HOST'];

    /** @var array<string, array{mixed, mixed}> */
    private array $before = [];

    protected function tearDown(): void
    {
        foreach ($this->before as $name => [$env, $server]) {
            self::restore($_ENV, $name, $env);
            self::restore($_SERVER, $name, $server);
        }
        $this->before = [];
        parent::tearDown();
    }

    public function testWithoutTheSettingsEveryPageStaysWhereItIs(): void
    {
        $this->client->request('GET', 'http://other.localhost/login');
        self::assertResponseIsSuccessful('A host this server does not name is left alone.');
        $this->client->request('GET', 'http://localhost:5173/login?x=1');
        self::assertResponseRedirects('http://localhost/login?x=1', null, 'A proxy that sends the sign-in pages on the web app\'s host to the API gets them back on the API host.');
        $this->client->request('GET', 'http://localhost/login');
        self::assertResponseIsSuccessful();

        $this->client->request('GET', '/.well-known/oauth-authorization-server');
        self::assertSame('http://localhost/oauth/authorize', $this->decodedResponse()['authorization_endpoint'] ?? null);

        $this->client->request('GET', 'http://other.localhost/api/v1/server-info');
        self::assertResponseIsSuccessful();
    }

    public function testSignInMovesToItsOwnHostWhileTheIssuerStays(): void
    {
        $this->useSettings(['AUTH_PUBLIC_URL' => 'http://app.localhost']);
        $this->bootstrapOAuthClients();
        $this->createUser('kim@example.test', 'Kim');

        $this->client->request('GET', '/.well-known/oauth-authorization-server');
        $metadata = $this->decodedResponse();
        self::assertSame('http://localhost', $metadata['issuer'] ?? null);
        self::assertSame('http://app.localhost/oauth/authorize', $metadata['authorization_endpoint'] ?? null);
        self::assertSame('http://localhost/oauth/token', $metadata['token_endpoint'] ?? null);

        // An installed app that still opens the API host is sent on, with its whole request.
        $verifier = bin2hex(random_bytes(32));
        $query = http_build_query([
            'response_type' => 'code',
            'client_id' => 'web',
            'redirect_uri' => $this->callback(),
            'scope' => 'mail:read',
            'state' => 'moved',
            'code_challenge' => rtrim(strtr(base64_encode(hash('sha256', $verifier, true)), '+/', '-_'), '='),
            'code_challenge_method' => 'S256',
        ]);
        $this->client->request('GET', 'http://localhost/oauth/authorize?'.$query);
        self::assertResponseRedirects('http://app.localhost/oauth/authorize?'.$query);
        foreach (['/login', '/logout'] as $path) {
            $this->client->request('GET', 'http://localhost'.$path);
            self::assertResponseRedirects('http://app.localhost'.$path);
        }

        // Signing in on the sign-in host, with its own cookies, and fetching the token from the API host.
        $crawler = $this->client->request('GET', 'http://app.localhost/login');
        self::assertResponseIsSuccessful();
        $this->client->submit($crawler->selectButton('Sign in')->form(['_username' => 'kim@example.test', '_password' => self::DEFAULT_PASSWORD]));
        $this->client->request('GET', 'http://app.localhost/oauth/authorize?'.$query);
        $location = (string) $this->client->getResponse()->headers->get('Location');
        self::assertStringStartsWith($this->callback().'?', $location);
        parse_str((string) parse_url($location, \PHP_URL_QUERY), $answer);
        self::assertIsString($answer['code'] ?? null);

        $this->client->request('POST', 'http://localhost/oauth/token', [
            'grant_type' => 'authorization_code',
            'client_id' => 'web',
            'redirect_uri' => $this->callback(),
            'code' => $answer['code'],
            'code_verifier' => $verifier,
        ]);
        self::assertResponseIsSuccessful();
        self::assertIsString($this->decodedResponse()['access_token'] ?? null);
    }

    public function testMcpAnswersOnItsOwnHostAndTheOldAddressKeepsWorking(): void
    {
        $this->useSettings(['MCP_PUBLIC_URL' => 'http://mcp.localhost']);
        $this->bootstrapOAuthClients();
        $this->createUser('kim@example.test', 'Kim');

        foreach (['mcp.localhost' => 'http://mcp.localhost', 'localhost' => 'http://localhost'] as $host => $base) {
            $this->mcpPost(['HTTP_HOST' => $host], ['jsonrpc' => '2.0', 'id' => 1, 'method' => 'initialize']);
            self::assertResponseStatusCodeSame(401);
            self::assertSame(\sprintf('Bearer resource_metadata="%s/.well-known/oauth-protected-resource/mcp"', $base), $this->client->getResponse()->headers->get('WWW-Authenticate'), 'The challenge names the host that was asked.');

            $this->client->request('GET', $base.'/.well-known/oauth-protected-resource/mcp');
            self::assertResponseIsSuccessful();
            self::assertSame($base.'/mcp', $this->decodedResponse()['resource'] ?? null);
            self::assertSame(['http://localhost'], $this->decodedResponse()['authorization_servers'] ?? null);
        }

        $headers = $this->userHeaders('kim@example.test', ['settings:read']);
        foreach (['mcp.localhost', 'localhost'] as $host) {
            $session = $this->mcpInitialize([...$headers, 'HTTP_HOST' => $host]);
            self::assertSame('kim@example.test', $this->mcpCallOk([...$headers, 'HTTP_HOST' => $host], $session, 'get_me')['email'] ?? null, $host);
        }

        $resources = static::getContainer()->get(ProtectedResources::class);
        self::assertTrue($resources->isKnown('http://mcp.localhost/mcp'));
        self::assertTrue($resources->isKnown('http://localhost/mcp'), 'Clients set up with the old address still ask for it.');

        foreach (['/api/v1/server-info', '/login', '/oauth/token', '/.well-known/oauth-authorization-server'] as $path) {
            $this->client->request('GET', 'http://mcp.localhost'.$path);
            self::assertResponseStatusCodeSame(404, 'The MCP host is no second API host: '.$path);
        }
    }

    public function testTheOldMcpAddressCanBeTurnedOff(): void
    {
        $this->useSettings(['MCP_PUBLIC_URL' => 'http://mcp.localhost', 'MCP_ON_API_HOST' => '0']);

        $this->mcpPost([], ['jsonrpc' => '2.0', 'id' => 1, 'method' => 'initialize']);
        self::assertResponseStatusCodeSame(404);

        $this->client->request('GET', 'http://localhost/.well-known/oauth-protected-resource/mcp');
        self::assertSame('http://mcp.localhost/mcp', $this->decodedResponse()['resource'] ?? null, 'Asked on the API host, the metadata names the only address left.');
        self::assertFalse(static::getContainer()->get(ProtectedResources::class)->isKnown('http://localhost/mcp'));

        $this->mcpPost(['HTTP_HOST' => 'mcp.localhost'], ['jsonrpc' => '2.0', 'id' => 1, 'method' => 'initialize']);
        self::assertResponseStatusCodeSame(401);
    }

    /**
     * Sets these addresses and starts a new kernel that reads them.
     *
     * @param array<string, string> $settings
     */
    private function useSettings(array $settings): void
    {
        foreach (self::SETTINGS as $name) {
            $this->before[$name] ??= [$_ENV[$name] ?? null, $_SERVER[$name] ?? null];
        }
        foreach ($settings as $name => $value) {
            $_ENV[$name] = $value;
            $_SERVER[$name] = $value;
        }
        self::ensureKernelShutdown();
        $this->client = static::createClient();
        $this->client->disableReboot();
    }

    private function callback(): string
    {
        $webAppUrl = $_SERVER['WEB_APP_URL'] ?? null;
        self::assertIsString($webAppUrl);

        return rtrim($webAppUrl, '/').'/auth/callback';
    }

    /** @param array<mixed> $variables */
    private static function restore(array &$variables, string $name, mixed $value): void
    {
        if (null === $value) {
            unset($variables[$name]);
        } else {
            $variables[$name] = $value;
        }
    }
}
