<?php

declare(strict_types=1);

namespace App\Tests\Functional;

use App\Entity\User;
use App\Repository\UserRepository;
use App\Security\OAuth\Consents;
use App\Security\OAuth\ProtectedResources;
use App\Security\OAuth\PurgeExpiredOAuthTokens;
use App\Security\OAuth\PurgeExpiredOAuthTokensHandler;
use App\Security\OAuth\PurgeUnusedRegisteredClients;
use App\Security\OAuth\PurgeUnusedRegisteredClientsHandler;
use App\Security\OAuth\RegistrationLimits;
use Doctrine\DBAL\ArrayParameterType;
use League\Bundle\OAuth2ServerBundle\Manager\ClientManagerInterface;
use League\Bundle\OAuth2ServerBundle\Model\Client;
use PHPUnit\Framework\Attributes\DataProvider;
use Symfony\Bundle\FrameworkBundle\Console\Application;
use Symfony\Component\Console\Tester\CommandTester;
use Symfony\Component\DomCrawler\Crawler;
use Symfony\Component\HttpFoundation\Request;
use Symfony\Component\Uid\Uuid;

/**
 * Apps that are not ours (such as MCP clients): they find this server through its metadata, register themselves,
 * and get a token only after the user allows them on the consent screen. The user can see and disconnect them.
 */
final class ThirdPartyOAuthTest extends DatabaseTestCase
{
    use AuthenticatesUsers;
    use ConnectsThirdPartyApps;

    private const string REDIRECT = 'http://127.0.0.1:33418/callback';
    private const string WEB_REDIRECT = 'https://notes.example/oauth/callback';
    private const array THIRD_PARTY_SCOPES = [
        'mail:read', 'mail:write', 'mail:send', 'todos:read', 'todos:write', 'calendar:read', 'calendar:write',
        'settings:read', 'settings:write', 'signatures:read', 'signatures:write',
    ];

    protected function setUp(): void
    {
        parent::setUp();
        $this->bootstrapOAuthClients();
        $this->createUser('kim@example.test', 'Kim Visser');
        $this->createUser('lisa@example.test', 'Lisa Bakker');
        $this->resetRegistrationLimits('203.0.113.7', '203.0.113.8', '203.0.113.9', '198.51.100.1', '198.51.100.8', '192.0.2.9', '2001:db8:1:2::1', '2001:db8:1:3::1', '2001:db8:1:4::1', '2001:db8:2::1');
    }

    public function testTheAuthorizationServerDescribesItself(): void
    {
        $this->client->request('GET', '/.well-known/oauth-authorization-server');

        self::assertResponseIsSuccessful();
        self::assertResponseHeaderSame('Content-Type', 'application/json');
        self::assertSame([
            'issuer' => 'http://localhost',
            'authorization_endpoint' => 'http://localhost/oauth/authorize',
            'token_endpoint' => 'http://localhost/oauth/token',
            'registration_endpoint' => 'http://localhost/oauth/register',
            'revocation_endpoint' => 'http://localhost/oauth/revoke',
            'revocation_endpoint_auth_methods_supported' => ['none'],
            'scopes_supported' => self::THIRD_PARTY_SCOPES,
            'response_types_supported' => ['code'],
            'response_modes_supported' => ['query'],
            'grant_types_supported' => ['authorization_code', 'refresh_token'],
            'code_challenge_methods_supported' => ['S256'],
            'token_endpoint_auth_methods_supported' => ['none'],
        ], $this->decodedResponse());
        $this->assertNoReservedScopes($this->decodedResponse()['scopes_supported']);

        $this->client->request('GET', '/.well-known/openid-configuration');
        self::assertResponseStatusCodeSame(404, 'This server issues no ID tokens, so it offers no OpenID configuration.');
    }

    public function testTheApiAndTheMcpEndpointDescribeThemselves(): void
    {
        foreach (['/.well-known/oauth-protected-resource' => ['http://localhost', 'Tresso API'], '/.well-known/oauth-protected-resource/mcp' => ['http://localhost/mcp', 'Tresso MCP']] as $path => [$resource, $name]) {
            $this->client->request('GET', $path);

            self::assertResponseIsSuccessful();
            self::assertSame([
                'resource' => $resource,
                'resource_name' => $name,
                'authorization_servers' => ['http://localhost'],
                'scopes_supported' => self::THIRD_PARTY_SCOPES,
                'bearer_methods_supported' => ['header'],
            ], $this->decodedResponse());
        }

        $resources = static::getContainer()->get(ProtectedResources::class);
        self::assertSame('http://localhost/mcp', $resources->mcpResource());
        self::assertSame('Bearer resource_metadata="http://localhost/.well-known/oauth-protected-resource/mcp"', $resources->mcpChallengeFor(Request::create('http://localhost/mcp')));
    }

    public function testBrowserClientsMayReadTheMetadataAndRegisterFromAnyOrigin(): void
    {
        foreach (['/.well-known/oauth-authorization-server' => 'GET', '/oauth/register' => 'POST', '/oauth/token' => 'POST'] as $path => $method) {
            $this->client->request('OPTIONS', $path, server: [
                'HTTP_ORIGIN' => 'https://inspector.example',
                'HTTP_ACCESS_CONTROL_REQUEST_METHOD' => $method,
                'HTTP_ACCESS_CONTROL_REQUEST_HEADERS' => 'content-type,mcp-protocol-version',
            ]);

            self::assertResponseIsSuccessful($path);
            self::assertResponseHeaderSame('Access-Control-Allow-Origin', 'https://inspector.example', $path);
            self::assertFalse($this->client->getResponse()->headers->has('Access-Control-Allow-Credentials'), $path);
        }

        $this->client->request('OPTIONS', '/api/v1/me', server: [
            'HTTP_ORIGIN' => 'https://inspector.example',
            'HTTP_ACCESS_CONTROL_REQUEST_METHOD' => 'GET',
        ]);
        self::assertFalse($this->client->getResponse()->headers->has('Access-Control-Allow-Origin'), 'The API itself stays closed to other origins.');
    }

    public function testRegistersAPublicClient(): void
    {
        $this->client->jsonRequest('POST', '/oauth/register', [
            'client_name' => '  Claude  ',
            'redirect_uris' => [self::REDIRECT, 'https://claude.example/api/mcp/auth_callback', 'http://localhost:6274/oauth/callback', 'http://[::1]:5000/cb'],
            'token_endpoint_auth_method' => 'none',
            'grant_types' => ['authorization_code', 'refresh_token'],
            'response_types' => ['code'],
            'scope' => 'mail:read signatures:read',
            'client_uri' => 'https://claude.example',
            'logo_uri' => 'https://claude.example/logo.png',
        ]);

        self::assertResponseStatusCodeSame(201);
        self::assertTrue($this->client->getResponse()->headers->hasCacheControlDirective('no-store'));
        $registered = $this->decodedResponse();
        $clientId = $registered['client_id'] ?? null;
        self::assertIsString($clientId);
        self::assertMatchesRegularExpression('/^[0-9a-f]{32}$/', $clientId);
        self::assertIsInt($registered['client_id_issued_at'] ?? null);
        self::assertEqualsWithDelta(time(), $registered['client_id_issued_at'], 60);
        unset($registered['client_id'], $registered['client_id_issued_at']);
        self::assertSame([
            'client_name' => 'Claude',
            'redirect_uris' => [self::REDIRECT, 'https://claude.example/api/mcp/auth_callback', 'http://localhost:6274/oauth/callback', 'http://[::1]:5000/cb'],
            'grant_types' => ['authorization_code', 'refresh_token'],
            'response_types' => ['code'],
            'token_endpoint_auth_method' => 'none',
            'scope' => 'mail:read signatures:read',
        ], $registered, 'client_uri and logo_uri are ignored.');

        $row = $this->connection()->fetchAssociative('SELECT c.secret, c.allow_plain_text_pkce, r.created_at, r.last_used_at FROM oauth2_client c JOIN registered_client r ON r.client_id = c.identifier WHERE c.identifier = :id', ['id' => $clientId]);
        self::assertIsArray($row);
        self::assertNull($row['secret'], 'A registered client is public.');
        self::assertFalse($row['allow_plain_text_pkce']);
        self::assertNull($row['last_used_at']);
    }

    public function testRegistrationDefaultsToEveryThirdPartyScopeAndBothGrants(): void
    {
        $registered = $this->register(['client_name' => 'Claude', 'redirect_uris' => ['https://claude.example/api/mcp/auth_callback']]);

        self::assertSame(implode(' ', self::THIRD_PARTY_SCOPES), $registered['scope'] ?? null);
        self::assertSame(['authorization_code', 'refresh_token'], $registered['grant_types'] ?? null);
        self::assertSame('none', $registered['token_endpoint_auth_method'] ?? null);
    }

    public function testNamesThatOnlyLookCloseAreAccepted(): void
    {
        foreach (['Fortress Office', 'Trésorerie', 'Café Helper 2', 'Mail assistant (beta)', 'Mattress Organizer', 'Fortress-Office', 'Mattress Sort', 'Tresse Studio'] as $name) {
            self::assertSame($name, $this->register(['client_name' => $name, 'redirect_uris' => [self::REDIRECT]])['client_name'] ?? null);
        }
    }

    public function testAcceptsAReverseDomainScheme(): void
    {
        $registered = $this->register(['client_name' => 'Native app', 'redirect_uris' => ['com.example.app:/oauth2redirect']]);

        self::assertSame(['com.example.app:/oauth2redirect'], $registered['redirect_uris'] ?? null);
    }

    /**
     * @param array<string, mixed> $metadata
     */
    #[DataProvider('refusedRegistrations')]
    public function testRefusesRegistrationsAnAppThatIsNotOursCannotHave(array $metadata, string $error): void
    {
        $this->client->jsonRequest('POST', '/oauth/register', $metadata + ['client_name' => 'App', 'redirect_uris' => [self::REDIRECT]]);

        self::assertResponseStatusCodeSame(400);
        self::assertSame($error, $this->decodedResponse()['error'] ?? null);
        self::assertIsString($this->decodedResponse()['error_description'] ?? null);
        self::assertSame(0, $this->countRows('SELECT COUNT(*) FROM registered_client'));
    }

    /**
     * @return iterable<string, array{array<string, mixed>, string}>
     */
    public static function refusedRegistrations(): iterable
    {
        $uris = static fn (string ...$uris): array => ['redirect_uris' => $uris];

        yield 'http on another host' => [$uris('http://app.example/callback'), 'invalid_redirect_uri'];
        yield 'http on a host that looks like loopback' => [$uris('http://127.0.0.1.evil.example/callback'), 'invalid_redirect_uri'];
        yield 'a fragment' => [$uris('https://app.example/callback#done'), 'invalid_redirect_uri'];
        yield 'a wildcard' => [$uris('https://*.app.example/callback'), 'invalid_redirect_uri'];
        yield 'credentials in the URI' => [$uris('https://user:pass@app.example/callback'), 'invalid_redirect_uri'];
        yield 'a one-word app scheme' => [$uris('myapp://callback'), 'invalid_redirect_uri'];
        yield 'a one-word scheme with a dotted host' => [$uris('cursor://anysphere.cursor-mcp/oauth/callback'), 'invalid_redirect_uri'];
        yield 'a file share' => [$uris('smb://attacker.example/share'), 'invalid_redirect_uri'];
        yield 'a Windows handler' => [$uris('ms-msdt://a.b/x'), 'invalid_redirect_uri'];
        yield 'a scheme the browser runs' => [$uris('javascript://example.com/%0Aalert(1)'), 'invalid_redirect_uri'];
        yield 'a data URI' => [$uris('data:text/html,<script>alert(1)</script>'), 'invalid_redirect_uri'];
        yield 'a file URI' => [$uris('file:///etc/passwd'), 'invalid_redirect_uri'];
        yield 'our own apps\' scheme' => [$uris('tresso://auth.example/callback'), 'invalid_redirect_uri'];
        yield 'our mobile app\'s scheme' => [$uris('app.tresso.mobile:/callback'), 'invalid_redirect_uri'];
        yield 'a Tresso domain as a scheme' => [$uris('tresso.app:/cb'), 'invalid_redirect_uri'];
        yield 'a Tresso domain reversed' => [$uris('com.gettresso:/cb'), 'invalid_redirect_uri'];
        yield 'a Tresso host' => [$uris('https://api.tresso.app/cb'), 'invalid_redirect_uri'];
        yield 'a host in another script' => [$uris('https://tréssо.app/cb'), 'invalid_redirect_uri'];
        yield 'a backslash in the host' => [$uris('https://evil.com\\.tresso.app/cb'), 'invalid_redirect_uri'];
        yield 'a percent sign in the host' => [$uris('https://tresso.app%40evil.com/cb'), 'invalid_redirect_uri'];
        yield 'a Tresso label under another domain' => [$uris('https://tresso.app.evil.example/cb'), 'invalid_redirect_uri'];
        yield 'Tresso inside a label' => [$uris('https://login-tresso.app/cb'), 'invalid_redirect_uri'];
        yield 'a look-alike Tresso domain' => [$uris('https://gettresso.co/cb'), 'invalid_redirect_uri'];
        yield 'a zero for an o in the host' => [$uris('https://tress0.com/cb'), 'invalid_redirect_uri'];
        yield 'fives for s in the host' => [$uris('https://tre55o.com/cb'), 'invalid_redirect_uri'];
        yield 'a hyphen inside Tresso in the host' => [$uris('https://tres-so.app/cb'), 'invalid_redirect_uri'];
        yield 'an Apple system scheme' => [$uris('x-apple.systempreferences:/cb'), 'invalid_redirect_uri'];
        yield 'a Windows system scheme' => [$uris('microsoft.windows.camera:/cb'), 'invalid_redirect_uri'];
        yield 'an Apple app scheme' => [$uris('com.apple.mobilesafari:/cb'), 'invalid_redirect_uri'];
        yield 'a Google app scheme' => [$uris('com.google.android.gm:/cb'), 'invalid_redirect_uri'];
        yield 'an Android scheme' => [$uris('android.settings:/cb'), 'invalid_redirect_uri'];
        yield 'a relative URI' => [$uris('/callback'), 'invalid_redirect_uri'];
        yield 'one of them bad' => [$uris(self::REDIRECT, 'http://app.example/callback'), 'invalid_redirect_uri'];
        yield 'no redirect URIs' => [$uris(), 'invalid_redirect_uri'];
        yield 'redirect URIs not a list' => [['redirect_uris' => self::REDIRECT], 'invalid_redirect_uri'];
        yield 'more than 10 redirect URIs' => [$uris(...array_map(static fn (int $port): string => 'http://127.0.0.1:'.$port.'/cb', range(8001, 8011))), 'invalid_redirect_uri'];
        yield 'a sync scope' => [['scope' => 'mail:read sync:credentials'], 'invalid_client_metadata'];
        yield 'a teams scope' => [['scope' => 'teams:read'], 'invalid_client_metadata'];
        yield 'the webhooks scope' => [['scope' => 'webhooks:manage'], 'invalid_client_metadata'];
        yield 'an unknown scope' => [['scope' => 'offline_access'], 'invalid_client_metadata'];
        yield 'a confidential client' => [['token_endpoint_auth_method' => 'client_secret_basic'], 'invalid_client_metadata'];
        yield 'a client secret posted' => [['token_endpoint_auth_method' => 'client_secret_post'], 'invalid_client_metadata'];
        yield 'client credentials' => [['grant_types' => ['client_credentials']], 'invalid_client_metadata'];
        yield 'refresh without code' => [['grant_types' => ['refresh_token']], 'invalid_client_metadata'];
        yield 'the implicit flow' => [['response_types' => ['token']], 'invalid_client_metadata'];
        yield 'no name' => [['client_name' => null], 'invalid_client_metadata'];
        yield 'a blank name' => [['client_name' => '   '], 'invalid_client_metadata'];
        yield 'a name too long' => [['client_name' => str_repeat('a', 101)], 'invalid_client_metadata'];
        yield 'a name with a line break' => [['client_name' => "Mail\nHelper"], 'invalid_client_metadata'];
        yield 'a name that reverses text' => [['client_name' => "Mail \u{202E}repleH"], 'invalid_client_metadata'];
        yield 'a name that says Tresso' => [['client_name' => 'Tresso'], 'invalid_client_metadata'];
        yield 'a name with Tresso in it' => [['client_name' => 'Official TRESSO helper'], 'invalid_client_metadata'];
        yield 'a name with Tresso in look-alike letters' => [['client_name' => 'Тrеssо'], 'invalid_client_metadata'];
        yield 'a name with Cyrillic s' => [['client_name' => 'Treѕѕo'], 'invalid_client_metadata'];
        yield 'a name in mathematical bold' => [['client_name' => '𝐓𝐫𝐞𝐬𝐬𝐨'], 'invalid_client_metadata'];
        yield 'a name with a Cherokee T' => [['client_name' => 'Ꭲresso'], 'invalid_client_metadata'];
        yield 'a name with a zero for an o' => [['client_name' => 'Tress0'], 'invalid_client_metadata'];
        yield 'a name with z for s' => [['client_name' => 'Trezzo'], 'invalid_client_metadata'];
        yield 'a name with a long run' => [['client_name' => 'Tressso Mail'], 'invalid_client_metadata'];
        yield 'a name in another script' => [['client_name' => 'Почта'], 'invalid_client_metadata'];
        yield 'a name with a hair space inside' => [['client_name' => "Tres\u{200A}so"], 'invalid_client_metadata'];
        yield 'a name with a line separator inside' => [['client_name' => "Tres\u{2028}so"], 'invalid_client_metadata'];
        yield 'a name with a no-break space inside' => [['client_name' => "Tres\u{00A0}so"], 'invalid_client_metadata'];
        yield 'a name with no-break spaces only' => [['client_name' => "Mail\u{00A0}helper"], 'invalid_client_metadata'];
        yield 'a name spelled out' => [['client_name' => 'T r e s s o'], 'invalid_client_metadata'];
        yield 'a name with dots between the letters' => [['client_name' => 'T.r.e.s.s.o'], 'invalid_client_metadata'];
        yield 'a name with a hyphen inside' => [['client_name' => 'Tres-so'], 'invalid_client_metadata'];
        yield 'a name with an underscore inside' => [['client_name' => 'Tres_so'], 'invalid_client_metadata'];
        yield 'a name with a tone letter for s' => [['client_name' => 'Tresƨo'], 'invalid_client_metadata'];
        yield 'a name with Tresso inside a word' => [['client_name' => 'MyTresso'], 'invalid_client_metadata'];
        yield 'a name like xT r e s s o' => [['client_name' => 'xT r e s s o'], 'invalid_client_metadata'];
        yield 'a name like xTres so' => [['client_name' => 'xTres so'], 'invalid_client_metadata'];
        yield 'a name like MyTres so' => [['client_name' => 'MyTres so'], 'invalid_client_metadata'];
        yield 'a name like ATres-so' => [['client_name' => 'ATres-so'], 'invalid_client_metadata'];
        yield 'a name like Mytr ess o' => [['client_name' => 'Mytr ess o'], 'invalid_client_metadata'];
        yield 'a name like Tr€sso' => [['client_name' => 'Tr€sso'], 'invalid_client_metadata'];
        yield 'a name like Tres s℮' => [['client_name' => 'Tres s℮'], 'invalid_client_metadata'];
        yield 'a name like Tr℮sso' => [['client_name' => 'Tr℮sso'], 'invalid_client_metadata'];
        yield 'a name like Tres s°' => [['client_name' => 'Tres s°'], 'invalid_client_metadata'];
        yield 'a name like Tres sᴑ' => [['client_name' => 'Tres sᴑ'], 'invalid_client_metadata'];
        yield 'a name like Tres sᴓ' => [['client_name' => 'Tres sᴓ'], 'invalid_client_metadata'];
        yield 'a name like Tres sɵ' => [['client_name' => 'Tres sɵ'], 'invalid_client_metadata'];
        yield 'a name like Tres sɔ' => [['client_name' => 'Tres sɔ'], 'invalid_client_metadata'];
        yield 'a name like Trɘs so' => [['client_name' => 'Trɘs so'], 'invalid_client_metadata'];
        yield 'a name like Trǝs so' => [['client_name' => 'Trǝs so'], 'invalid_client_metadata'];
    }

    public function testRefusesABodyThatIsNotJson(): void
    {
        $this->client->request('POST', '/oauth/register', server: ['CONTENT_TYPE' => 'application/json'], content: 'client_name=App');

        self::assertResponseStatusCodeSame(400);
        self::assertSame('invalid_client_metadata', $this->decodedResponse()['error'] ?? null);
    }

    public function testIpv6AddressesAreLimitedPerNetwork(): void
    {
        for ($i = 1; $i <= 60; ++$i) {
            $this->registerFrom('2001:db8:1:2::'.dechex($i));
            self::assertResponseStatusCodeSame(201, 'Registration '.$i);
        }

        $this->registerFrom('2001:db8:1:2:ffff:ffff:ffff:ffff');
        self::assertResponseStatusCodeSame(429, 'Another address in the same /64 shares the limit.');

        // In tests a /48 may register 65 an hour (200 elsewhere).
        for ($i = 1; $i <= 5; ++$i) {
            $this->registerFrom('2001:db8:1:3::'.dechex($i));
            self::assertResponseStatusCodeSame(201, 'Another /64 in the /48: registration '.$i);
        }
        $this->registerFrom('2001:db8:1:4::1');
        self::assertResponseStatusCodeSame(429, 'The /48 is full.');

        $this->registerFrom('2001:db8:2::1');
        self::assertResponseStatusCodeSame(201, 'Another /48 has its own limit.');
    }

    public function testIpv4MappedAddressesCountAsIpv4(): void
    {
        for ($i = 1; $i <= 60; ++$i) {
            $this->registerFrom('203.0.113.7');
            self::assertResponseStatusCodeSame(201, 'Registration '.$i);
        }

        $this->registerFrom('::ffff:203.0.113.7');
        self::assertResponseStatusCodeSame(429);

        self::assertSame('203.0.113.7', RegistrationLimits::senderKey('::ffff:203.0.113.7'));
        self::assertSame('203.0.113.0/24', RegistrationLimits::networkKey('::ffff:203.0.113.7'));
        self::assertSame('2001:db8:1:2::/64', RegistrationLimits::senderKey('2001:db8:1:2:aaaa::1'));
        self::assertSame('2001:db8:1::/48', RegistrationLimits::networkKey('2001:db8:1:2:aaaa::1'));
    }

    public function testRegistrationIsLimitedInTotal(): void
    {
        // In tests the total is 70 an hour (5000 elsewhere); addresses in different /24s.
        foreach (['203.0.113.7' => 60, '198.51.100.8' => 10] as $address => $count) {
            for ($i = 1; $i <= $count; ++$i) {
                $this->client->jsonRequest('POST', '/oauth/register', ['client_name' => 'App', 'redirect_uris' => [self::REDIRECT]], ['REMOTE_ADDR' => $address]);
                self::assertResponseStatusCodeSame(201);
            }
        }

        $this->client->jsonRequest('POST', '/oauth/register', ['client_name' => 'App', 'redirect_uris' => [self::REDIRECT]], ['REMOTE_ADDR' => '192.0.2.9']);
        self::assertResponseStatusCodeSame(429);
        self::assertSame('temporarily_unavailable', $this->decodedResponse()['error'] ?? null);
    }

    public function testIpv4AddressesAreLimitedPerNetwork(): void
    {
        for ($i = 1; $i <= 60; ++$i) {
            $this->registerFrom('203.0.113.7');
        }
        // In tests a /24 may register 65 an hour (200 elsewhere).
        for ($i = 1; $i <= 5; ++$i) {
            $this->registerFrom('203.0.113.8');
            self::assertResponseStatusCodeSame(201, 'Another address in the /24: registration '.$i);
        }

        $this->registerFrom('203.0.113.9');
        self::assertResponseStatusCodeSame(429, 'The /24 is full.');
        $this->registerFrom('198.51.100.1');
        self::assertResponseStatusCodeSame(201, 'Another /24 has its own limit.');
        self::assertSame('203.0.113.0/24', RegistrationLimits::networkKey('203.0.113.200'));
    }

    public function testRegistrationIsLimitedPerAddress(): void
    {
        for ($i = 1; $i <= 60; ++$i) {
            $this->client->jsonRequest('POST', '/oauth/register', ['client_name' => 'App '.$i, 'redirect_uris' => [self::REDIRECT]], ['REMOTE_ADDR' => '203.0.113.7']);
            self::assertResponseStatusCodeSame(201, 'Registration '.$i);
        }

        $this->client->jsonRequest('POST', '/oauth/register', ['client_name' => 'One too many', 'redirect_uris' => [self::REDIRECT]], ['REMOTE_ADDR' => '203.0.113.7']);
        self::assertResponseStatusCodeSame(429);
        self::assertSame('temporarily_unavailable', $this->decodedResponse()['error'] ?? null);
        self::assertGreaterThan(0, (int) $this->client->getResponse()->headers->get('Retry-After'));
        self::assertSame(60, $this->countRows('SELECT COUNT(*) FROM registered_client'));

        $this->client->jsonRequest('POST', '/oauth/register', ['client_name' => 'Elsewhere', 'redirect_uris' => [self::REDIRECT]], ['REMOTE_ADDR' => '203.0.113.8']);
        self::assertResponseStatusCodeSame(201, 'Another address has its own limit.');
    }

    public function testTheUserAllowsAnAppAndItsTokenWorksWithinItsScopes(): void
    {
        $clientId = $this->registeredClientId();
        $this->client->jsonRequest('POST', '/api/v1/signatures', ['name' => 'Work', 'html' => '<p>Kim</p>'], $this->userHeaders('kim@example.test', ['signatures:write']));
        self::assertResponseStatusCodeSame(201);

        $this->signIn('kim@example.test');
        $verifier = $this->verifier();
        $crawler = $this->authorize($clientId, ['signatures:read', 'todos:read'], $verifier, 'state-1');

        self::assertResponseIsSuccessful('The first time, the user is asked.');
        self::assertResponseHeaderSame('X-Frame-Options', 'DENY');
        self::assertStringContainsString("frame-ancestors 'none'", (string) $this->client->getResponse()->headers->get('Content-Security-Policy'));
        self::assertTrue($this->client->getResponse()->headers->hasCacheControlDirective('no-store'));
        self::assertSelectorTextContains('h1', 'Allow MCP Inspector?');
        self::assertSelectorTextContains('.address-domain', '127.0.0.1');
        self::assertSelectorTextContains('.address-note', 'An app on this computer.');
        self::assertSelectorTextContains('.warning', 'Tresso has not checked this app');
        self::assertSelectorTextContains('.lead', 'kim@example.test');
        self::assertSame(['See signatures', 'See todos'], $crawler->filter('.scopes li strong')->each(static fn (Crawler $item): string => $item->text()));
        self::assertSame(0, $this->countRows('SELECT COUNT(*) FROM oauth_consent'), 'Showing the screen allows nothing yet.');

        $code = $this->answer($crawler, 'Allow', 'state-1');
        self::assertSame(1, $this->countRows('SELECT COUNT(*) FROM oauth_consent'));

        $token = $this->exchange($clientId, $code, $verifier);
        $this->client->request('GET', '/api/v1/signatures', server: $this->bearer($token['access_token']));
        self::assertResponseIsSuccessful();
        self::assertSame(['Work'], array_column($this->decodedResponse(), 'name'));

        $this->client->request('GET', '/api/v1/mail-accounts', server: $this->bearer($token['access_token']));
        self::assertResponseStatusCodeSame(403, 'Outside the scopes the user allowed.');

        self::assertSame(1, $this->countRows('SELECT COUNT(*) FROM registered_client WHERE last_used_at IS NOT NULL'));
        self::assertSame(1, $this->countRows('SELECT COUNT(*) FROM oauth_consent WHERE last_used_at IS NOT NULL'));
    }

    public function testTheSecondTimeAnAppOnTheWebIsApprovedWithoutAskingUnlessItWantsMore(): void
    {
        $clientId = $this->registeredClientId(['redirect_uris' => [self::WEB_REDIRECT]]);
        $web = ['redirect_uri' => self::WEB_REDIRECT];
        $this->signIn('kim@example.test');
        $crawler = $this->authorize($clientId, ['signatures:read', 'todos:read'], $this->verifier(), 'first', $web);
        self::assertResponseIsSuccessful();
        $this->client->submit($crawler->selectButton('Allow')->form());
        self::assertStringStartsWith(self::WEB_REDIRECT.'?code=', (string) $this->client->getResponse()->headers->get('Location'));

        foreach ([['signatures:read', 'todos:read'], ['todos:read']] as $scopes) {
            $this->authorize($clientId, $scopes, $this->verifier(), 'again', $web);
            self::assertResponseRedirects();
            self::assertStringStartsWith(self::WEB_REDIRECT.'?code=', (string) $this->client->getResponse()->headers->get('Location'), implode(' ', $scopes));
        }

        $crawler = $this->authorize($clientId, ['todos:read', 'todos:write'], $this->verifier(), 'more', $web);
        self::assertResponseIsSuccessful('A scope the user did not allow yet: asked again.');
        self::assertSame(['See todos', 'Change todos'], $crawler->filter('.scopes li strong')->each(static fn (Crawler $item): string => $item->text()));
        $this->client->submit($crawler->selectButton('Allow')->form());

        $scopes = $this->connection()->fetchOne('SELECT scopes FROM oauth_consent');
        self::assertIsString($scopes);
        self::assertSame(['signatures:read', 'todos:read', 'todos:write'], json_decode($scopes, true), 'What was allowed before stays allowed.');
    }

    /**
     * Nothing proves which program on the computer asks for a loopback or custom-scheme redirect (RFC 8252 8.6): any
     * program can use the app's public client id. So the user is asked every time, even for what they allowed.
     */
    public function testAnAppOnThisComputerIsAskedEveryTime(): void
    {
        $clientId = $this->registeredClientId();
        $this->connect('kim@example.test', $clientId, ['signatures:read', 'todos:read']);
        $this->signIn('kim@example.test');

        $crawler = $this->authorize($clientId, ['todos:read'], $this->verifier(), 'again');

        self::assertResponseIsSuccessful('No silent approval for an app on this computer.');
        self::assertStringContainsString('You allowed this app before', $crawler->filter('.warning')->text());
        self::assertSame(['See todos'], $crawler->filter('.scopes li strong')->each(static fn (Crawler $item): string => $item->text()));
        $this->answer($crawler, 'Allow', 'again');

        $reverseDomain = $this->registeredClientId(['redirect_uris' => ['com.example.notes:/callback']]);
        $this->signIn('kim@example.test');
        $verifier = $this->verifier();
        $this->client->submit($this->authorize($reverseDomain, ['todos:read'], $verifier, 'scheme', ['redirect_uri' => 'com.example.notes:/callback'])->selectButton('Allow')->form());
        $this->authorize($reverseDomain, ['todos:read'], $this->verifier(), 'scheme-again', ['redirect_uri' => 'com.example.notes:/callback']);
        self::assertResponseIsSuccessful('An app\'s own scheme proves nothing either.');
    }

    public function testDenyingSendsAccessDenied(): void
    {
        $clientId = $this->registeredClientId();
        $this->signIn('kim@example.test');
        $crawler = $this->authorize($clientId, ['mail:read'], $this->verifier(), 'state-2');

        $this->client->submit($crawler->selectButton('Deny')->form());

        $location = (string) $this->client->getResponse()->headers->get('Location');
        self::assertStringStartsWith(self::REDIRECT.'?', $location);
        parse_str((string) parse_url($location, \PHP_URL_QUERY), $query);
        self::assertSame('access_denied', $query['error'] ?? null);
        self::assertSame('state-2', $query['state'] ?? null);
        self::assertArrayNotHasKey('code', $query);
        self::assertSame(0, $this->countRows('SELECT COUNT(*) FROM oauth_consent'));
    }

    public function testAnswersNeedTheCsrfTokenOfThePage(): void
    {
        $clientId = $this->registeredClientId();
        $this->signIn('kim@example.test');
        $verifier = $this->verifier();
        $crawler = $this->authorize($clientId, ['mail:read'], $verifier, 'state-3');
        $action = (string) $crawler->filter('form.decision')->attr('action');

        foreach (['no token' => ['decision' => 'allow'], 'a wrong token' => ['decision' => 'allow', '_csrf_token' => 'forged']] as $case => $fields) {
            $this->client->request('POST', $action, $fields);

            self::assertResponseStatusCodeSame(400, $case);
            self::assertSelectorTextContains('.error', 'answer again');
            self::assertSame(0, $this->countRows('SELECT COUNT(*) FROM oauth_consent'), $case);
        }

        $this->client->request('POST', $action, ['decision' => 'maybe', '_csrf_token' => (string) $crawler->filter('input[name="_csrf_token"]')->attr('value')]);
        self::assertResponseStatusCodeSame(400);
        self::assertSame(0, $this->countRows('SELECT COUNT(*) FROM oauth_consent'));
    }

    public function testOurOwnAppsAreStillApprovedWithoutAsking(): void
    {
        $this->signIn('kim@example.test');
        $this->client->request('GET', '/oauth/authorize?'.http_build_query([
            'response_type' => 'code',
            'client_id' => 'web',
            'redirect_uri' => $this->webRedirectUri(),
            'scope' => 'mail:read',
            'state' => 's',
            'code_challenge' => $this->challenge($this->verifier()),
            'code_challenge_method' => 'S256',
        ]));

        self::assertResponseRedirects();
        self::assertStringContainsString('code=', (string) $this->client->getResponse()->headers->get('Location'));
        self::assertSame(0, $this->countRows('SELECT COUNT(*) FROM oauth_consent'));
    }

    public function testErrorsBeforeTheUserAllowedTheAppStayOnAPageOfOurOwn(): void
    {
        $clientId = $this->registeredClientId(['scope' => 'mail:read']);
        $this->signIn('kim@example.test');

        foreach (['mail:send' => 'not registered', 'teams:read' => 'reserved', 'sync:credentials' => 'a sync scope', 'nonsense' => 'unknown to the server'] as $scope => $case) {
            $this->authorize($clientId, [$scope], $this->verifier(), 'state-4');

            self::assertResponseStatusCodeSame(400, $case);
            self::assertFalse($this->client->getResponse()->headers->has('Location'), $case.': the browser is not sent to the app.');
            self::assertSelectorTextContains('h1', 'This request cannot be completed');
            self::assertSelectorTextContains('code', 'invalid_scope');
            self::assertSelectorTextContains('.error', 'The app asked for permissions it cannot have.');
            self::assertStringNotContainsString($scope, (string) $this->client->getResponse()->getContent(), $case.': nothing from the request is shown.');
            self::assertResponseHeaderSame('X-Frame-Options', 'DENY');
        }

        $this->authorize($clientId, ['Your-account-is-locked.Call-0800-SCAM'], $this->verifier(), 'state-6');
        self::assertResponseStatusCodeSame(400);
        self::assertStringNotContainsString('SCAM', (string) $this->client->getResponse()->getContent());

        $this->authorize($clientId, ['mail:read'], $this->verifier(), 'state-5', ['resource' => 'https://evil.example/mcp']);
        self::assertResponseStatusCodeSame(400);
        self::assertSelectorTextContains('code', 'invalid_target');
        self::assertSame(0, $this->countRows('SELECT COUNT(*) FROM oauth_consent'));
    }

    public function testOnceAllowedTheAppGetsItsErrorsByRedirect(): void
    {
        $clientId = $this->registeredClientId(['scope' => 'mail:read']);
        $this->connect('kim@example.test', $clientId, ['mail:read']);
        $this->signIn('kim@example.test');

        $this->authorize($clientId, ['mail:send'], $this->verifier(), 'state-4');

        self::assertResponseRedirects();
        parse_str((string) parse_url((string) $this->client->getResponse()->headers->get('Location'), \PHP_URL_QUERY), $query);
        self::assertSame('invalid_scope', $query['error'] ?? null);
        self::assertSame('state-4', $query['state'] ?? null);
    }

    public function testAnUnregisteredRedirectUriIsNeverUsed(): void
    {
        $clientId = $this->registeredClientId();
        $this->signIn('kim@example.test');

        $this->client->request('GET', '/oauth/authorize?'.http_build_query([
            'response_type' => 'code', 'client_id' => $clientId, 'redirect_uri' => 'https://evil.example/cb', 'scope' => 'mail:read',
            'state' => 's', 'code_challenge' => $this->challenge($this->verifier()), 'code_challenge_method' => 'S256',
        ]));

        self::assertResponseStatusCodeSame(401);
        self::assertSame('invalid_client', $this->decodedResponse()['error'] ?? null);
        self::assertFalse($this->client->getResponse()->headers->has('Location'));
    }

    /**
     * RFC 8252 7.3: on the loopback addresses the port is chosen when the app starts, so any port matches. `localhost`
     * is a name, not a loopback address, and must match exactly, port included (the bundle's own rule).
     */
    public function testOnlyLoopbackAddressesMayChangeTheirPort(): void
    {
        $clientId = $this->registeredClientId(['redirect_uris' => ['http://127.0.0.1:1000/cb', 'http://[::1]:1000/cb', 'http://localhost:6274/cb']]);
        $this->signIn('kim@example.test');
        $request = fn (string $redirectUri) => $this->client->request('GET', '/oauth/authorize?'.http_build_query([
            'response_type' => 'code', 'client_id' => $clientId, 'redirect_uri' => $redirectUri, 'scope' => 'mail:read',
            'state' => 's', 'code_challenge' => $this->challenge($this->verifier()), 'code_challenge_method' => 'S256',
        ]));

        foreach (['http://127.0.0.1:52813/cb', 'http://[::1]:52813/cb', 'http://localhost:6274/cb'] as $allowed) {
            $request($allowed);
            self::assertResponseIsSuccessful($allowed);
            self::assertSelectorExists('form.decision');
        }

        $request('http://localhost:9999/cb');
        self::assertResponseStatusCodeSame(401);
        self::assertSame('invalid_client', $this->decodedResponse()['error'] ?? null);
    }

    public function testTheConsentScreenShowsTheNameAsTextAndTheHostInLowerCase(): void
    {
        $clientId = $this->registeredClientId(['client_name' => '<img src=x onerror=alert(1)> Helper', 'redirect_uris' => ['https://Claude.Example/cb']]);
        $this->signIn('kim@example.test');

        $this->client->request('GET', '/oauth/authorize?'.http_build_query([
            'response_type' => 'code', 'client_id' => $clientId, 'redirect_uri' => 'https://Claude.Example/cb', 'scope' => 'mail:read',
            'state' => 's', 'code_challenge' => $this->challenge($this->verifier()), 'code_challenge_method' => 'S256',
        ]));

        self::assertResponseIsSuccessful();
        self::assertSelectorNotExists('img');
        self::assertSelectorTextContains('h1', 'Allow <img src=x onerror=alert(1)> Helper?');
        self::assertStringContainsString('&lt;img src=x onerror=alert(1)&gt;', (string) $this->client->getResponse()->getContent());
        self::assertSelectorTextSame('.address-domain', 'claude.example');
    }

    public function testTheResourceParameterMustNameWhatThisServerProtects(): void
    {
        $clientId = $this->registeredClientId();
        $this->signIn('kim@example.test');
        $verifier = $this->verifier();

        $crawler = $this->authorize($clientId, ['mail:read'], $verifier, 'state-5', ['resource' => 'http://localhost/mcp']);
        self::assertResponseIsSuccessful();
        $code = $this->answer($crawler, 'Allow', 'state-5');
        $token = $this->exchange($clientId, $code, $verifier, ['resource' => 'http://localhost/mcp']);
        self::assertNotSame('', $token['access_token'], 'The token request may name the resource too.');

        $this->authorize($clientId, ['mail:read'], $this->verifier(), 'state-6', ['resource' => 'http://localhost/']);
        self::assertStringContainsString('code=', (string) $this->client->getResponse()->headers->get('Location'), 'The API itself, with a trailing slash.');

        $this->authorize($clientId, ['mail:read'], $this->verifier(), 'state-7', ['resource' => 'https://evil.example/mcp']);
        parse_str((string) parse_url((string) $this->client->getResponse()->headers->get('Location'), \PHP_URL_QUERY), $query);
        self::assertSame('invalid_target', $query['error'] ?? null);
        self::assertSame('state-7', $query['state'] ?? null);
    }

    public function testPkceWithS256IsRequired(): void
    {
        $clientId = $this->registeredClientId();
        $this->signIn('kim@example.test');
        $base = ['response_type' => 'code', 'client_id' => $clientId, 'redirect_uri' => self::REDIRECT, 'scope' => 'mail:read', 'state' => 's'];

        $this->client->request('GET', '/oauth/authorize?'.http_build_query($base));
        self::assertResponseStatusCodeSame(400);
        self::assertSame('invalid_request', $this->decodedResponse()['error'] ?? null);

        $this->client->request('GET', '/oauth/authorize?'.http_build_query($base + ['code_challenge' => str_repeat('a', 43), 'code_challenge_method' => 'plain']));
        self::assertResponseStatusCodeSame(400, 'Plain PKCE is refused.');
        self::assertSame('invalid_request', $this->decodedResponse()['error'] ?? null);
        self::assertSame(0, $this->countRows('SELECT COUNT(*) FROM oauth_consent'));
    }

    public function testAThirdPartyTokenCannotManageTokensOrConnectedApps(): void
    {
        $clientId = $this->registeredClientId();
        $token = $this->connect('kim@example.test', $clientId, ['settings:read', 'settings:write', 'mail:read']);
        $headers = $this->bearer($token['access_token']);
        $consentId = $this->connection()->fetchOne('SELECT id FROM oauth_consent');
        self::assertIsString($consentId);

        $this->client->request('GET', '/api/v1/mail-accounts', server: $headers);
        self::assertResponseIsSuccessful('The token itself is valid.');

        $this->client->request('GET', '/api/v1/personal-access-tokens', server: $headers);
        self::assertResponseStatusCodeSame(403);
        $this->client->jsonRequest('POST', '/api/v1/personal-access-tokens', ['name' => 'Sneaky', 'scopes' => ['mail:read']], $headers);
        self::assertResponseStatusCodeSame(403);
        $this->client->request('GET', '/api/v1/connected-apps', server: $headers);
        self::assertResponseStatusCodeSame(403);
        $this->client->request('DELETE', '/api/v1/connected-apps/'.$consentId, server: $headers);
        self::assertResponseStatusCodeSame(403);
        $this->client->request('GET', '/api/v1/realtime/token', server: $headers);
        self::assertResponseStatusCodeSame(403, 'A realtime token would outlive disconnecting the app.');

        self::assertSame(1, $this->countRows('SELECT COUNT(*) FROM oauth_consent'));
    }

    public function testTheUserSeesTheirConnectedApps(): void
    {
        $clientId = $this->registeredClientId();
        $this->connect('kim@example.test', $clientId, ['signatures:read', 'mail:read']);

        $this->client->request('GET', '/api/v1/connected-apps', server: $this->userHeaders('kim@example.test', ['settings:read']));

        self::assertResponseIsSuccessful();
        $apps = $this->decodedResponse();
        self::assertCount(1, $apps);
        self::assertIsArray($apps[0]);
        self::assertSame(['id', 'name', 'domains', 'scopes', 'connectedAt', 'lastUsedAt'], array_keys($apps[0]));
        self::assertSame('MCP Inspector', $apps[0]['name']);
        self::assertSame(['127.0.0.1'], $apps[0]['domains']);
        self::assertSame(['signatures:read', 'mail:read'], $apps[0]['scopes']);
        self::assertIsString($apps[0]['connectedAt']);
        self::assertIsString($apps[0]['lastUsedAt']);

        $this->client->request('GET', '/api/v1/connected-apps', server: $this->userHeaders('lisa@example.test', ['settings:read']));
        self::assertSame([], $this->decodedResponse());
    }

    public function testConnectedAppsListEveryPlaceTheAppSendsPeople(): void
    {
        $clientId = $this->registeredClientId(['redirect_uris' => [self::REDIRECT, 'https://claude.example/a', 'https://claude.example/b', 'https://other.example/cb', 'com.example.app:/cb']]);
        $this->connect('kim@example.test', $clientId, ['mail:read']);

        $this->client->request('GET', '/api/v1/connected-apps', server: $this->userHeaders('kim@example.test', ['settings:read']));

        $first = $this->decodedResponse()[0] ?? null;
        self::assertIsArray($first);
        self::assertSame(['127.0.0.1', 'claude.example', 'other.example', 'com.example.app'], $first['domains'] ?? null);
    }

    public function testAPersonalAccessTokenCannotSeeOrDisconnectConnectedApps(): void
    {
        $clientId = $this->registeredClientId();
        $this->connect('kim@example.test', $clientId, ['mail:read']);
        $consentId = $this->connection()->fetchOne('SELECT id FROM oauth_consent');
        self::assertIsString($consentId);
        $pat = $this->personalAccessTokenHeaders('kim@example.test', ['settings:read', 'settings:write']);

        $this->client->request('GET', '/api/v1/connected-apps', server: $pat);
        self::assertResponseStatusCodeSame(403);
        $this->client->request('DELETE', '/api/v1/connected-apps/'.$consentId, server: $pat);
        self::assertResponseStatusCodeSame(403);
        self::assertSame(1, $this->countRows('SELECT COUNT(*) FROM oauth_consent'));
    }

    public function testNoTokenWithoutAConsentEvenForAnOldRefreshTokenOrCode(): void
    {
        $clientId = $this->registeredClientId();
        $token = $this->connect('kim@example.test', $clientId, ['signatures:read']);
        $this->signIn('kim@example.test');
        $verifier = $this->verifier();
        $this->authorize($clientId, ['signatures:read'], $verifier, 'code');
        parse_str((string) parse_url((string) $this->client->getResponse()->headers->get('Location'), \PHP_URL_QUERY), $query);
        $code = $query['code'] ?? null;
        self::assertIsString($code);

        // As if disconnecting raced with these requests: the consent is gone, the tokens were not revoked yet.
        $this->connection()->executeStatement('DELETE FROM oauth_consent');

        $this->refresh($clientId, $token['refresh_token']);
        self::assertResponseStatusCodeSame(400);
        self::assertSame('invalid_grant', $this->decodedResponse()['error'] ?? null);

        $this->client->request('POST', '/oauth/token', ['grant_type' => 'authorization_code', 'client_id' => $clientId, 'redirect_uri' => self::REDIRECT, 'code' => $code, 'code_verifier' => $verifier]);
        self::assertResponseStatusCodeSame(400);
        self::assertSame('invalid_grant', $this->decodedResponse()['error'] ?? null);
    }

    public function testAllowingTwiceAtOnceKeepsOneConsentWithEveryScope(): void
    {
        $clientId = $this->registeredClientId();
        $user = static::getContainer()->get(UserRepository::class)->findOneBy(['email' => 'kim@example.test']);
        self::assertInstanceOf(User::class, $user);
        $client = static::getContainer()->get(ClientManagerInterface::class)->find($clientId);
        self::assertInstanceOf(Client::class, $client);
        // The other answer was saved after this one looked and found nothing.
        $this->connection()->executeStatement(
            "INSERT INTO oauth_consent (id, user_id, client_id, scopes, created_at) VALUES (:id, :user, :client, '[\"mail:read\"]', NOW())",
            ['id' => Uuid::v7()->toRfc4122(), 'user' => $user->getId()->toRfc4122(), 'client' => $clientId],
        );

        $consent = static::getContainer()->get(Consents::class)->allow($user, $client, ['todos:read']);

        self::assertSame(['mail:read', 'todos:read'], $consent->getScopes());
        self::assertSame(1, $this->countRows('SELECT COUNT(*) FROM oauth_consent'));
        $scopes = $this->connection()->fetchOne('SELECT scopes FROM oauth_consent');
        self::assertIsString($scopes);
        self::assertSame(['mail:read', 'todos:read'], json_decode($scopes, true));
    }

    public function testDisconnectingRevokesTheAppsTokens(): void
    {
        $clientId = $this->registeredClientId();
        $token = $this->connect('kim@example.test', $clientId, ['signatures:read']);
        $lisasToken = $this->connect('lisa@example.test', $clientId, ['signatures:read']);

        $refreshed = $this->refresh($clientId, $token['refresh_token']);
        self::assertResponseIsSuccessful('Refresh tokens work, and rotate.');
        self::assertNotSame($token['refresh_token'], $refreshed['refresh_token']);

        $kim = $this->userHeaders('kim@example.test', ['settings:read', 'settings:write']);
        $this->client->request('GET', '/api/v1/connected-apps', server: $kim);
        $first = $this->decodedResponse()[0] ?? null;
        self::assertIsArray($first);
        $id = $first['id'] ?? null;
        self::assertIsString($id);

        $this->client->request('DELETE', '/api/v1/connected-apps/'.$id, server: $kim);
        self::assertResponseStatusCodeSame(204);

        foreach ([$token['access_token'], $refreshed['access_token']] as $accessToken) {
            $this->client->request('GET', '/api/v1/signatures', server: $this->bearer($accessToken));
            self::assertResponseStatusCodeSame(401);
        }
        $this->refresh($clientId, $refreshed['refresh_token']);
        self::assertResponseStatusCodeSame(400);
        self::assertSame('invalid_grant', $this->decodedResponse()['error'] ?? null);

        $this->client->request('GET', '/api/v1/connected-apps', server: $kim);
        self::assertSame([], $this->decodedResponse());

        $this->client->request('GET', '/api/v1/signatures', server: $this->bearer($lisasToken['access_token']));
        self::assertResponseIsSuccessful("Lisa's connection to the same app is untouched.");

        $this->signIn('kim@example.test');
        $this->authorize($clientId, ['signatures:read'], $this->verifier(), 'back');
        self::assertResponseIsSuccessful('After disconnecting, the user is asked again.');
        self::assertSelectorExists('form.decision');
    }

    public function testOtherUsersCannotDisconnectTheApp(): void
    {
        $clientId = $this->registeredClientId();
        $token = $this->connect('kim@example.test', $clientId, ['signatures:read']);
        $consentId = $this->connection()->fetchOne('SELECT id FROM oauth_consent');
        self::assertIsString($consentId);

        $lisa = $this->userHeaders('lisa@example.test', ['settings:read', 'settings:write']);
        $this->client->request('DELETE', '/api/v1/connected-apps/'.$consentId, server: $lisa);
        self::assertResponseStatusCodeSame(404);
        $this->client->request('DELETE', '/api/v1/connected-apps/not-a-uuid', server: $lisa);
        self::assertResponseStatusCodeSame(404);

        $this->client->request('GET', '/api/v1/signatures', server: $this->bearer($token['access_token']));
        self::assertResponseIsSuccessful();
        self::assertSame(1, $this->countRows('SELECT COUNT(*) FROM oauth_consent'));
    }

    public function testDeletingTheUserDeletesWhatTheyAllowed(): void
    {
        $clientId = $this->registeredClientId();
        $this->connect('kim@example.test', $clientId, ['signatures:read']);
        $this->connect('lisa@example.test', $clientId, ['signatures:read']);

        $tester = new CommandTester(new Application($this->client->getKernel())->find('app:users:delete'));
        $tester->execute(['email' => 'kim@example.test', '--force' => true]);
        $tester->assertCommandIsSuccessful();

        self::assertSame(1, $this->countRows("SELECT COUNT(*) FROM oauth_consent c JOIN app_user u ON u.id = c.user_id WHERE u.email = 'lisa@example.test'"));
        self::assertSame(1, $this->countRows('SELECT COUNT(*) FROM oauth_consent'));
        self::assertSame(1, $this->countRows('SELECT COUNT(*) FROM registered_client'), 'The app itself stays registered.');
    }

    public function testRegisteredClientsNobodyUsedAreDeletedAfter30Days(): void
    {
        $fresh = $this->registeredClientId();
        $usedLongAgo = $this->registeredClientId();
        $this->connect('kim@example.test', $usedLongAgo, ['mail:read']);
        $unused = $this->registeredClientId();
        // Allowed, but the app never fetched its token.
        $allowedOnly = $this->registeredClientId();
        $this->signIn('kim@example.test');
        $this->answer($this->authorize($allowedOnly, ['mail:read'], $this->verifier(), 'allowed'), 'Allow', 'allowed');
        $old = [$usedLongAgo, $unused, $allowedOnly];
        $this->connection()->executeStatement("UPDATE registered_client SET created_at = NOW() - INTERVAL '31 days' WHERE client_id IN (:ids)", ['ids' => $old], ['ids' => ArrayParameterType::STRING]);
        $firstParty = $this->connection()->fetchFirstColumn('SELECT identifier FROM oauth2_client WHERE identifier NOT IN (SELECT client_id FROM registered_client) ORDER BY identifier');

        $deleted = static::getContainer()->get(PurgeUnusedRegisteredClientsHandler::class)(new PurgeUnusedRegisteredClients());

        self::assertSame(1, $deleted);
        self::assertEqualsCanonicalizing([$fresh, $usedLongAgo, $allowedOnly], $this->connection()->fetchFirstColumn('SELECT client_id FROM registered_client'));
        self::assertSame(0, $this->countRows('SELECT COUNT(*) FROM oauth2_client WHERE identifier = :id', ['id' => $unused]));
        self::assertSame(2, $this->countRows('SELECT COUNT(*) FROM oauth_consent'));
        self::assertSame(['desktop', 'mobile', 'sync-worker', 'web'], $firstParty);
        self::assertSame($firstParty, $this->connection()->fetchFirstColumn('SELECT identifier FROM oauth2_client WHERE identifier NOT IN (SELECT client_id FROM registered_client) ORDER BY identifier'), 'Our own clients are never touched.');
    }

    public function testExpiredTokensAndCodesArePurgedButDisconnectingStillFindsLiveOnes(): void
    {
        $clientId = $this->registeredClientId();
        $live = $this->connect('kim@example.test', $clientId, ['signatures:read']);
        $expired = $this->connect('lisa@example.test', $clientId, ['signatures:read']);
        $liveAccess = self::jti($live['access_token']);
        $expiredAccess = self::jti($expired['access_token']);
        // Both access tokens are past their hour; only the second pair's refresh token is past its 30 days too. Days
        // apart, so the database's clock and zone do not matter.
        $this->connection()->executeStatement("UPDATE oauth2_access_token SET expiry = NOW() - INTERVAL '2 days'");
        $this->connection()->executeStatement("UPDATE oauth2_refresh_token SET expiry = NOW() - INTERVAL '2 days' WHERE access_token = :id", ['id' => $expiredAccess]);
        $this->connection()->executeStatement("UPDATE oauth2_authorization_code SET expiry = NOW() - INTERVAL '2 days'");
        $codes = $this->countRows('SELECT COUNT(*) FROM oauth2_authorization_code');
        self::assertGreaterThan(0, $codes);

        $deleted = static::getContainer()->get(PurgeExpiredOAuthTokensHandler::class)(new PurgeExpiredOAuthTokens());

        self::assertSame(2 + $codes, $deleted, 'The expired refresh token, its access token and every code.');
        self::assertSame(0, $this->countRows('SELECT COUNT(*) FROM oauth2_authorization_code'));
        self::assertSame(0, $this->countRows('SELECT COUNT(*) FROM oauth2_access_token WHERE identifier = :id', ['id' => $expiredAccess]));
        self::assertSame(1, $this->countRows('SELECT COUNT(*) FROM oauth2_access_token WHERE identifier = :id', ['id' => $liveAccess]), 'A live refresh token keeps its access token.');
        self::assertSame(1, $this->countRows('SELECT COUNT(*) FROM oauth2_refresh_token WHERE access_token = :id', ['id' => $liveAccess]));

        $kim = $this->userHeaders('kim@example.test', ['settings:read', 'settings:write']);
        $consentId = $this->connection()->fetchOne("SELECT c.id FROM oauth_consent c JOIN app_user u ON u.id = c.user_id WHERE u.email = 'kim@example.test'");
        self::assertIsString($consentId);
        $this->client->request('DELETE', '/api/v1/connected-apps/'.$consentId, server: $kim);
        self::assertResponseStatusCodeSame(204);

        $this->refresh($clientId, $live['refresh_token']);
        self::assertResponseStatusCodeSame(400);
        self::assertSame('invalid_grant', $this->decodedResponse()['error'] ?? null, 'Disconnecting still revoked it.');
    }

    /** The id of an access token, from its (unverified) claims. */
    private static function jti(string $accessToken): string
    {
        $payload = json_decode(base64_decode(strtr(explode('.', $accessToken)[1] ?? '', '-_', '+/'), true) ?: '', true);
        self::assertIsArray($payload);
        $jti = $payload['jti'] ?? null;
        self::assertIsString($jti);

        return $jti;
    }

    private function registerFrom(string $address): void
    {
        $this->client->jsonRequest('POST', '/oauth/register', ['client_name' => 'App', 'redirect_uris' => [self::REDIRECT]], ['REMOTE_ADDR' => $address]);
    }

    /**
     * @param array<string, mixed> $metadata
     *
     * @return array<mixed>
     */
    private function register(array $metadata): array
    {
        $this->client->jsonRequest('POST', '/oauth/register', $metadata);
        self::assertResponseStatusCodeSame(201);

        return $this->decodedResponse();
    }

    /**
     * @param array<string, mixed> $metadata
     */
    private function registeredClientId(array $metadata = []): string
    {
        $clientId = $this->register($metadata + ['client_name' => 'MCP Inspector', 'redirect_uris' => [self::REDIRECT]])['client_id'] ?? null;
        self::assertIsString($clientId);

        return $clientId;
    }

    private function signIn(string $email): void
    {
        $this->client->getCookieJar()->clear();
        $crawler = $this->client->request('GET', '/login');
        $this->client->submit($crawler->selectButton('Sign in')->form(['_username' => $email, '_password' => self::DEFAULT_PASSWORD]));
    }

    /**
     * @param list<string>          $scopes
     * @param array<string, string> $extra
     */
    private function authorize(string $clientId, array $scopes, string $verifier, string $state, array $extra = []): Crawler
    {
        return $this->client->request('GET', '/oauth/authorize?'.http_build_query([
            'response_type' => 'code',
            'client_id' => $clientId,
            'redirect_uri' => self::REDIRECT,
            'scope' => implode(' ', $scopes),
            'state' => $state,
            'code_challenge' => $this->challenge($verifier),
            'code_challenge_method' => 'S256',
            ...$extra,
        ]));
    }

    /** Presses a button on the consent screen and returns the code the app gets. */
    private function answer(Crawler $consentScreen, string $button, string $state): string
    {
        $this->client->submit($consentScreen->selectButton($button)->form());

        $location = (string) $this->client->getResponse()->headers->get('Location');
        self::assertStringStartsWith(self::REDIRECT.'?', $location);
        parse_str((string) parse_url($location, \PHP_URL_QUERY), $query);
        self::assertSame($state, $query['state'] ?? null);
        $code = $query['code'] ?? null;
        self::assertIsString($code);

        return $code;
    }

    /**
     * Signs the user in to the app through the consent screen and returns the app's tokens.
     *
     * @param list<string> $scopes
     *
     * @return array{access_token: string, refresh_token: string}
     */
    private function connect(string $email, string $clientId, array $scopes): array
    {
        $this->signIn($email);
        $verifier = $this->verifier();
        $crawler = $this->authorize($clientId, $scopes, $verifier, 'connect');
        self::assertResponseIsSuccessful();
        $token = $this->exchange($clientId, $this->answer($crawler, 'Allow', 'connect'), $verifier);
        $this->client->getCookieJar()->clear();

        return $token;
    }

    /**
     * @param array<string, string> $extra
     *
     * @return array{access_token: string, refresh_token: string}
     */
    private function exchange(string $clientId, string $code, string $verifier, array $extra = []): array
    {
        $this->client->request('POST', '/oauth/token', [
            'grant_type' => 'authorization_code',
            'client_id' => $clientId,
            'redirect_uri' => self::REDIRECT,
            'code' => $code,
            'code_verifier' => $verifier,
            ...$extra,
        ]);
        self::assertResponseIsSuccessful();

        return $this->tokens();
    }

    /**
     * @return array{access_token: string, refresh_token: string}
     */
    private function refresh(string $clientId, string $refreshToken): array
    {
        $this->client->request('POST', '/oauth/token', ['grant_type' => 'refresh_token', 'client_id' => $clientId, 'refresh_token' => $refreshToken]);
        if (!$this->client->getResponse()->isSuccessful()) {
            return ['access_token' => '', 'refresh_token' => ''];
        }

        return $this->tokens();
    }

    /**
     * @return array{access_token: string, refresh_token: string}
     */
    private function tokens(): array
    {
        return ['access_token' => $this->responseString('access_token'), 'refresh_token' => $this->responseString('refresh_token')];
    }

    private function verifier(): string
    {
        return bin2hex(random_bytes(32));
    }

    private function challenge(string $verifier): string
    {
        return rtrim(strtr(base64_encode(hash('sha256', $verifier, true)), '+/', '-_'), '=');
    }

    /** @return array<string, string> */
    private function bearer(string $accessToken): array
    {
        return ['HTTP_AUTHORIZATION' => 'Bearer '.$accessToken, 'HTTP_ACCEPT' => 'application/json'];
    }

    private function assertNoReservedScopes(mixed $scopes): void
    {
        self::assertIsArray($scopes);
        foreach ($scopes as $scope) {
            self::assertIsString($scope);
            self::assertDoesNotMatchRegularExpression('/^(sync|teams):|^webhooks:/', $scope);
        }
    }
}
