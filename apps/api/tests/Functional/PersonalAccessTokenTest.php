<?php

declare(strict_types=1);

namespace App\Tests\Functional;

use App\Security\PersonalAccessToken\PurgeOldPersonalAccessTokens;
use App\Security\PersonalAccessToken\PurgeOldPersonalAccessTokensHandler;
use App\Security\Scope;
use League\Bundle\OAuth2ServerBundle\Event\AuthorizationRequestResolveEvent;
use League\Bundle\OAuth2ServerBundle\Manager\ClientManagerInterface;
use League\Bundle\OAuth2ServerBundle\Model\Client;
use League\Bundle\OAuth2ServerBundle\OAuth2Events;
use League\Bundle\OAuth2ServerBundle\OAuth2Grants;
use League\Bundle\OAuth2ServerBundle\ValueObject\Grant;
use League\Bundle\OAuth2ServerBundle\ValueObject\RedirectUri;
use League\Bundle\OAuth2ServerBundle\ValueObject\Scope as OAuthScope;
use Symfony\Bundle\FrameworkBundle\Console\Application;
use Symfony\Component\Console\Tester\CommandTester;

final class PersonalAccessTokenTest extends DatabaseTestCase
{
    use AuthenticatesUsers;

    private const array SETTINGS = ['settings:read', 'settings:write'];

    /** @var array<string, string> */
    private array $kim;

    protected function setUp(): void
    {
        parent::setUp();
        $this->bootstrapOAuthClients();
        $this->createUser('kim@example.test', 'Kim Visser');
        $this->createUser('lisa@example.test', 'Lisa Bakker');
        // Every user scope, as the web app asks for: a token can only get what the session has.
        $this->kim = $this->userHeaders('kim@example.test', array_map(static fn (Scope $scope): string => $scope->value, Scope::userScopes()));
    }

    public function testCreateHandsOutTheSecretOnce(): void
    {
        $this->client->jsonRequest('POST', '/api/v1/personal-access-tokens', [
            'name' => '  Backup script  ',
            'scopes' => ['signatures:read', 'mail:read'],
        ], $this->kim);

        self::assertResponseStatusCodeSame(201);
        $this->assertNotStored();
        $created = $this->decodedResponse();
        $secret = $created['token'] ?? null;
        self::assertIsString($secret);
        self::assertMatchesRegularExpression('/^tresso_pat_[A-Za-z0-9_-]{43}$/', $secret);
        self::assertSame('Backup script', $created['name'] ?? null);
        self::assertSame(['signatures:read', 'mail:read'], $created['scopes'] ?? null);
        $prefix = $created['prefix'] ?? null;
        self::assertIsString($prefix);
        self::assertSame(substr($secret, 0, \strlen($prefix)), $prefix);
        self::assertSame(\strlen('tresso_pat_') + 6, \strlen($prefix));
        self::assertIsString($created['createdAt'] ?? null);
        self::assertIsString($created['expiresAt'] ?? null);
        $days = new \DateTimeImmutable($created['createdAt'])->diff(new \DateTimeImmutable($created['expiresAt']))->days;
        self::assertSame(90, $days, 'A token lasts 90 days unless asked otherwise.');

        $row = $this->connection()->fetchAssociative('SELECT * FROM personal_access_token WHERE id = :id', ['id' => $created['id'] ?? null]);
        self::assertIsArray($row);
        self::assertSame(hash('sha256', $secret), $row['token_hash']);
        self::assertStringNotContainsString($secret, (string) json_encode($row), 'The secret itself is never stored.');

        $this->client->request('GET', '/api/v1/personal-access-tokens', server: $this->kim);
        self::assertResponseIsSuccessful();
        $this->assertNotStored();
        $content = (string) $this->client->getResponse()->getContent();
        self::assertStringNotContainsString($secret, $content);
        self::assertStringNotContainsString(hash('sha256', $secret), $content);
        $listed = $this->decodedResponse();
        self::assertCount(1, $listed);
        self::assertIsArray($listed[0]);
        self::assertArrayNotHasKey('token', $listed[0]);
        self::assertArrayNotHasKey('tokenHash', $listed[0]);
        self::assertSame($prefix, $listed[0]['prefix'] ?? null);
        self::assertArrayHasKey('lastUsedAt', $listed[0]);
        self::assertNull($listed[0]['lastUsedAt']);
        self::assertArrayHasKey('revokedAt', $listed[0]);
        self::assertNull($listed[0]['revokedAt']);
    }

    public function testLifetimeIsOneOfTheOffered(): void
    {
        $this->client->jsonRequest('POST', '/api/v1/personal-access-tokens', ['name' => 'Yearly', 'scopes' => ['mail:read'], 'expiresInDays' => 365], $this->kim);
        self::assertResponseStatusCodeSame(201);
        $created = $this->decodedResponse();
        self::assertIsString($created['createdAt'] ?? null);
        self::assertIsString($created['expiresAt'] ?? null);
        self::assertSame(365, new \DateTimeImmutable($created['createdAt'])->diff(new \DateTimeImmutable($created['expiresAt']))->days);

        $this->client->jsonRequest('POST', '/api/v1/personal-access-tokens', ['name' => 'Forever', 'scopes' => ['mail:read'], 'expiresInDays' => 3650], $this->kim);
        self::assertResponseStatusCodeSame(422);
        self::assertSame(['expiresInDays'], $this->violationPaths());
    }

    public function testTokenWorksWithinItsScopes(): void
    {
        $this->client->jsonRequest('POST', '/api/v1/signatures', ['name' => 'Work', 'html' => '<p>Kim</p>'], $this->userHeaders('kim@example.test', ['signatures:write']));
        self::assertResponseStatusCodeSame(201);
        $secret = $this->createToken(['signatures:read']);

        $this->client->request('GET', '/api/v1/signatures', server: $this->patHeaders($secret));

        self::assertResponseIsSuccessful();
        self::assertSame(['Work'], array_column($this->decodedResponse(), 'name'));
    }

    public function testTokenIsRefusedOutsideItsScopes(): void
    {
        $headers = $this->patHeaders($this->createToken(['signatures:read']));

        $this->client->jsonRequest('POST', '/api/v1/signatures', ['name' => 'Work', 'html' => '<p>Kim</p>'], $headers);
        self::assertResponseStatusCodeSame(403);

        $this->client->request('GET', '/api/v1/mail-accounts', server: $headers);
        self::assertResponseStatusCodeSame(403);
    }

    public function testUnknownRevokedAndExpiredTokensAreRefusedLikeOAuthTokens(): void
    {
        $this->client->request('GET', '/api/v1/signatures', server: ['HTTP_AUTHORIZATION' => 'Bearer not-a-real-access-token', 'HTTP_ACCEPT' => 'application/json']);
        self::assertResponseStatusCodeSame(401);
        $oauthBody = (string) $this->client->getResponse()->getContent();
        $oauthChallenge = $this->client->getResponse()->headers->get('WWW-Authenticate');
        self::assertSame('Bearer', $oauthChallenge);

        $unknown = 'tresso_pat_'.str_repeat('A', 43);
        $revoked = $this->createToken(['signatures:read']);
        $this->client->request('DELETE', '/api/v1/personal-access-tokens/'.$this->tokenId($revoked), server: $this->kim);
        self::assertResponseStatusCodeSame(204);
        $expired = $this->createToken(['signatures:read']);
        $this->connection()->executeStatement(
            "UPDATE personal_access_token SET created_at = NOW() - INTERVAL '91 days', expires_at = NOW() - INTERVAL '1 second' WHERE token_hash = :hash",
            ['hash' => hash('sha256', $expired)],
        );

        foreach (['unknown' => $unknown, 'revoked' => $revoked, 'expired' => $expired] as $case => $secret) {
            $this->client->request('GET', '/api/v1/signatures', server: $this->patHeaders($secret));
            self::assertResponseStatusCodeSame(401, $case);
            self::assertSame($oauthBody, (string) $this->client->getResponse()->getContent(), $case);
            self::assertSame($oauthChallenge, $this->client->getResponse()->headers->get('WWW-Authenticate'), $case);
        }
    }

    public function testATokenCannotManageTokens(): void
    {
        $secret = $this->createToken(['settings:read', 'settings:write']);
        $id = $this->tokenId($secret);
        $headers = $this->patHeaders($secret);

        $this->client->request('GET', '/api/v1/personal-access-tokens', server: $headers);
        self::assertResponseStatusCodeSame(403);

        $this->client->jsonRequest('POST', '/api/v1/personal-access-tokens', ['name' => 'Another', 'scopes' => ['mail:read']], $headers);
        self::assertResponseStatusCodeSame(403);

        $this->client->request('DELETE', '/api/v1/personal-access-tokens/'.$id, server: $headers);
        self::assertResponseStatusCodeSame(403);

        self::assertSame(1, $this->countRows('SELECT COUNT(*) FROM personal_access_token'));
        self::assertSame(0, $this->countRows('SELECT COUNT(*) FROM personal_access_token WHERE revoked_at IS NOT NULL'));

        $this->client->request('GET', '/api/v1/server-info', server: $headers);
        self::assertResponseIsSuccessful();
    }

    public function testOtherUsersCannotSeeOrRevokeTheToken(): void
    {
        $secret = $this->createToken(['signatures:read']);
        $id = $this->tokenId($secret);
        $lisa = $this->userHeaders('lisa@example.test', self::SETTINGS);

        $this->client->request('GET', '/api/v1/personal-access-tokens', server: $lisa);
        self::assertResponseIsSuccessful();
        self::assertSame([], $this->decodedResponse());

        $this->client->request('DELETE', '/api/v1/personal-access-tokens/'.$id, server: $lisa);
        self::assertResponseStatusCodeSame(404);

        $this->client->request('GET', '/api/v1/signatures', server: $this->patHeaders($secret));
        self::assertResponseIsSuccessful();
    }

    public function testRevokingKeepsTheTokenInTheList(): void
    {
        $secret = $this->createToken(['signatures:read']);
        $id = $this->tokenId($secret);

        $this->client->request('DELETE', '/api/v1/personal-access-tokens/'.$id, server: $this->kim);
        self::assertResponseStatusCodeSame(204);
        $this->client->request('DELETE', '/api/v1/personal-access-tokens/'.$id, server: $this->kim);
        self::assertResponseStatusCodeSame(204, 'Revoking twice is not an error.');

        $this->client->request('GET', '/api/v1/personal-access-tokens', server: $this->kim);
        self::assertIsString($this->firstListed()['revokedAt'] ?? null);
    }

    /**
     * @param array<string, mixed> $payload
     */
    #[\PHPUnit\Framework\Attributes\DataProvider('invalidTokens')]
    public function testInvalidTokensAreRefused(array $payload, string $propertyPath): void
    {
        $this->client->jsonRequest('POST', '/api/v1/personal-access-tokens', $payload + ['name' => 'Script', 'scopes' => ['mail:read']], $this->kim);

        self::assertResponseStatusCodeSame(422);
        self::assertContains($propertyPath, $this->violationPaths());
        self::assertSame(0, $this->countRows('SELECT COUNT(*) FROM personal_access_token'));
    }

    /** @return iterable<string, array{array<string, mixed>, string}> */
    public static function invalidTokens(): iterable
    {
        yield 'sync scope' => [['scopes' => ['mail:read', 'sync:lease']], 'scopes[1]'];
        yield 'sync credentials' => [['scopes' => ['sync:credentials']], 'scopes[0]'];
        yield 'reserved teams scope' => [['scopes' => ['teams:read']], 'scopes[0]'];
        yield 'reserved webhooks scope' => [['scopes' => ['webhooks:manage']], 'scopes[0]'];
        yield 'unknown scope' => [['scopes' => ['everything']], 'scopes[0]'];
        yield 'no scopes' => [['scopes' => []], 'scopes'];
        yield 'blank name' => [['name' => '   '], 'name'];
        yield 'long name' => [['name' => str_repeat('a', 81)], 'name'];
    }

    public function testATokenGetsNoScopeTheSessionLacks(): void
    {
        $this->client->jsonRequest('POST', '/api/v1/personal-access-tokens', ['name' => 'Mailer', 'scopes' => ['settings:read', 'mail:send']], $this->userHeaders('kim@example.test', self::SETTINGS));

        self::assertResponseStatusCodeSame(422);
        self::assertSame(['scopes[1]'], $this->violationPaths());
        self::assertSame(0, $this->countRows('SELECT COUNT(*) FROM personal_access_token'));

        $this->client->jsonRequest('POST', '/api/v1/personal-access-tokens', ['name' => 'Mailer', 'scopes' => ['mail:send']], $this->userHeaders('kim@example.test', ['settings:write', 'mail:send']));
        self::assertResponseStatusCodeSame(201, 'With mail:send in the session, the token may have it.');
    }

    public function testATokenGetsNoRealtimeToken(): void
    {
        $headers = $this->patHeaders($this->createToken(['mail:read']));
        $this->client->request('GET', '/api/v1/mail-accounts', server: $this->patHeaders($this->createToken(['settings:read'])));
        self::assertResponseIsSuccessful();

        $this->client->request('GET', '/api/v1/realtime/token', server: $headers);

        self::assertResponseStatusCodeSame(403);
        self::assertStringNotContainsString('"token"', (string) $this->client->getResponse()->getContent());
    }

    public function testATokenNeverReachesTheSyncEndpoints(): void
    {
        $everything = array_map(static fn (Scope $scope): string => $scope->value, Scope::personalAccessTokenScopes());
        $headers = $this->patHeaders($this->createToken($everything));

        foreach (['/internal/sync/realtime-token', '/internal/sync/accounts/0190b4a0-0000-7000-8000-000000000000/credentials'] as $path) {
            $this->client->request('GET', $path, server: $headers);
            self::assertResponseStatusCodeSame(403, $path);
        }
        $this->client->jsonRequest('POST', '/internal/sync/leases', ['workerId' => 'script', 'capacity' => 1], $headers);
        self::assertResponseStatusCodeSame(403);
    }

    public function testOnlyOurOwnAppsManageTokens(): void
    {
        $worker = $this->workerHeaders('sync:lease');
        $thirdParty = $this->thirdPartyHeaders('kim@example.test', self::SETTINGS);
        $id = $this->tokenId($this->createToken(['mail:read']));

        $this->client->request('GET', '/api/v1/mail-accounts', server: $thirdParty);
        self::assertResponseIsSuccessful('The third-party token itself is valid.');

        foreach (['sync worker' => $worker, 'third-party app' => $thirdParty] as $caller => $headers) {
            $this->client->request('GET', '/api/v1/personal-access-tokens', server: $headers);
            self::assertResponseStatusCodeSame(403, $caller);
            $this->client->jsonRequest('POST', '/api/v1/personal-access-tokens', ['name' => 'Sneaky', 'scopes' => ['mail:read']], $headers);
            self::assertResponseStatusCodeSame(403, $caller);
            $this->client->request('DELETE', '/api/v1/personal-access-tokens/'.$id, server: $headers);
            self::assertResponseStatusCodeSame(403, $caller);
        }

        self::assertSame(1, $this->countRows('SELECT COUNT(*) FROM personal_access_token WHERE revoked_at IS NULL'));
    }

    public function testDeletingTheUserDeletesTheirTokens(): void
    {
        $kimsToken = $this->createToken(['signatures:read']);
        $this->client->request('GET', '/api/v1/signatures', server: $this->patHeaders($kimsToken));
        self::assertResponseIsSuccessful();
        $this->client->jsonRequest('POST', '/api/v1/personal-access-tokens', ['name' => 'Lisa', 'scopes' => ['mail:read']], $this->userHeaders('lisa@example.test', [...self::SETTINGS, 'mail:read']));
        self::assertResponseStatusCodeSame(201);

        $tester = new CommandTester(new Application($this->client->getKernel())->find('app:users:delete'));
        $tester->execute(['email' => 'kim@example.test', '--force' => true]);
        $tester->assertCommandIsSuccessful();

        self::assertSame(1, $this->countRows('SELECT COUNT(*) FROM personal_access_token'), "Only Lisa's token is left.");
        self::assertSame(1, $this->countRows("SELECT COUNT(*) FROM personal_access_token t JOIN app_user u ON u.id = t.owner_id WHERE u.email = 'lisa@example.test'"));

        $this->client->request('GET', '/api/v1/signatures', server: $this->patHeaders($kimsToken));
        self::assertResponseStatusCodeSame(401);
    }

    public function testLastUseIsRecordedAtMostOnceAMinute(): void
    {
        $secret = $this->createToken(['signatures:read']);
        $hash = hash('sha256', $secret);
        $lastUsedAt = fn (): mixed => $this->connection()->fetchOne('SELECT last_used_at FROM personal_access_token WHERE token_hash = :hash', ['hash' => $hash]);

        $this->client->request('GET', '/api/v1/signatures', server: $this->patHeaders($secret));
        self::assertResponseIsSuccessful();
        self::assertIsString($lastUsedAt());

        $this->connection()->executeStatement("UPDATE personal_access_token SET last_used_at = NOW() - INTERVAL '30 seconds' WHERE token_hash = :hash", ['hash' => $hash]);
        $recent = $lastUsedAt();
        $this->client->request('GET', '/api/v1/signatures', server: $this->patHeaders($secret));
        self::assertResponseIsSuccessful();
        self::assertSame($recent, $lastUsedAt(), 'Used again within a minute: nothing is written.');

        $this->connection()->executeStatement("UPDATE personal_access_token SET last_used_at = NOW() - INTERVAL '2 minutes' WHERE token_hash = :hash", ['hash' => $hash]);
        $old = $lastUsedAt();
        $this->client->request('GET', '/api/v1/signatures', server: $this->patHeaders($secret));
        self::assertResponseIsSuccessful();
        $now = $lastUsedAt();
        self::assertIsString($old);
        self::assertIsString($now);
        self::assertGreaterThan(new \DateTimeImmutable($old), new \DateTimeImmutable($now));

        $this->client->request('GET', '/api/v1/personal-access-tokens', server: $this->kim);
        self::assertIsString($this->firstListed()['lastUsedAt'] ?? null);
    }

    public function testOldRevokedAndExpiredTokensArePurged(): void
    {
        $kept = [$this->createToken(['mail:read']), $this->createToken(['mail:read']), $this->createToken(['mail:read'])];
        $purged = [$this->createToken(['mail:read']), $this->createToken(['mail:read'])];
        $set = function (string $secret, string $sql): void {
            $this->connection()->executeStatement('UPDATE personal_access_token SET '.$sql.' WHERE token_hash = :hash', ['hash' => hash('sha256', $secret)]);
        };
        $set($kept[1], "revoked_at = NOW() - INTERVAL '29 days'");
        $set($kept[2], "created_at = NOW() - INTERVAL '100 days', expires_at = NOW() - INTERVAL '29 days'");
        $set($purged[0], "revoked_at = NOW() - INTERVAL '31 days'");
        $set($purged[1], "created_at = NOW() - INTERVAL '200 days', expires_at = NOW() - INTERVAL '31 days'");

        $deleted = static::getContainer()->get(PurgeOldPersonalAccessTokensHandler::class)(new PurgeOldPersonalAccessTokens());

        self::assertSame(2, $deleted);
        $left = $this->connection()->fetchFirstColumn('SELECT token_hash FROM personal_access_token');
        self::assertEqualsCanonicalizing(array_map(static fn (string $secret): string => hash('sha256', $secret), $kept), $left);
    }

    /**
     * Makes a token for Kim and returns its secret.
     *
     * @param list<string> $scopes
     */
    private function createToken(array $scopes): string
    {
        $this->client->jsonRequest('POST', '/api/v1/personal-access-tokens', ['name' => 'Script', 'scopes' => $scopes], $this->kim);
        self::assertResponseStatusCodeSame(201);

        return $this->responseString('token');
    }

    private function tokenId(string $secret): string
    {
        $id = $this->connection()->fetchOne('SELECT id FROM personal_access_token WHERE token_hash = :hash', ['hash' => hash('sha256', $secret)]);
        self::assertIsString($id);

        return $id;
    }

    private function assertNotStored(): void
    {
        $headers = $this->client->getResponse()->headers;
        self::assertTrue($headers->hasCacheControlDirective('no-store'), (string) $headers->get('Cache-Control'));
        self::assertTrue($headers->hasCacheControlDirective('private'));
        self::assertSame('no-cache', $headers->get('Pragma'));
    }

    /**
     * Signs the user in to a client that is not one of our own apps, approved directly as if the user allowed it on the
     * consent screen (ThirdPartyOAuthTest goes through the screen itself).
     *
     * @param list<non-empty-string> $scopes
     *
     * @return array<string, string>
     */
    private function thirdPartyHeaders(string $email, array $scopes): array
    {
        $redirectUri = 'https://third-party.example/callback';
        $client = new Client('Third-party app', 'third-party', null);
        $client->setGrants(new Grant(OAuth2Grants::AUTHORIZATION_CODE));
        $client->setRedirectUris(new RedirectUri($redirectUri));
        $client->setScopes(...array_map(static fn (string $scope): OAuthScope => new OAuthScope($scope), $scopes));
        static::getContainer()->get(ClientManagerInterface::class)->save($client);
        static::getContainer()->get('event_dispatcher')->addListener(
            OAuth2Events::AUTHORIZATION_REQUEST_RESOLVE,
            static function (AuthorizationRequestResolveEvent $event): void {
                if ('third-party' === $event->getClient()->getIdentifier()) {
                    $event->resolveAuthorization(true);
                }
            },
            100,
        );

        $verifier = bin2hex(random_bytes(32));
        $this->client->getCookieJar()->clear();
        $crawler = $this->client->request('GET', '/login');
        $this->client->submit($crawler->selectButton('Sign in')->form(['_username' => $email, '_password' => self::DEFAULT_PASSWORD]));
        $this->client->request('GET', '/oauth/authorize?'.http_build_query([
            'response_type' => 'code',
            'client_id' => 'third-party',
            'redirect_uri' => $redirectUri,
            'scope' => implode(' ', $scopes),
            'state' => 'test',
            'code_challenge' => rtrim(strtr(base64_encode(hash('sha256', $verifier, true)), '+/', '-_'), '='),
            'code_challenge_method' => 'S256',
        ]));
        parse_str((string) parse_url((string) $this->client->getResponse()->headers->get('Location'), \PHP_URL_QUERY), $query);
        $code = $query['code'] ?? null;
        self::assertIsString($code, 'Authorization did not return a code.');

        $this->client->request('POST', '/oauth/token', [
            'grant_type' => 'authorization_code',
            'client_id' => 'third-party',
            'redirect_uri' => $redirectUri,
            'code' => $code,
            'code_verifier' => $verifier,
        ]);
        self::assertResponseIsSuccessful();
        $this->client->getCookieJar()->clear();

        return $this->patHeaders($this->responseString('access_token'));
    }

    /** @return array<mixed> */
    private function firstListed(): array
    {
        $first = $this->decodedResponse()[0] ?? null;
        self::assertIsArray($first);

        return $first;
    }

    /** @return list<mixed> */
    private function violationPaths(): array
    {
        $violations = $this->decodedResponse()['violations'] ?? null;
        self::assertIsArray($violations);

        return array_values(array_map(static fn (mixed $violation): mixed => \is_array($violation) ? ($violation['propertyPath'] ?? null) : null, $violations));
    }

    /** @return array<string, string> */
    private function patHeaders(string $secret): array
    {
        return ['HTTP_AUTHORIZATION' => 'Bearer '.$secret, 'HTTP_ACCEPT' => 'application/json'];
    }
}
