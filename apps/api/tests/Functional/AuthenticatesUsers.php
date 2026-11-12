<?php

declare(strict_types=1);

namespace App\Tests\Functional;

use App\Entity\User;
use App\Service\UserProvisioner;
use Symfony\Bundle\FrameworkBundle\Console\Application;
use Symfony\Bundle\FrameworkBundle\KernelBrowser;
use Symfony\Component\Console\Tester\CommandTester;

/**
 * Obtains real tokens through the OAuth2 server: users via the web client's authorization code + PKCE flow,
 * sync workers via client credentials.
 *
 * @property KernelBrowser $client
 */
trait AuthenticatesUsers
{
    private const string DEFAULT_PASSWORD = 'correct-horse-battery-staple';

    protected function bootstrapOAuthClients(): void
    {
        $tester = new CommandTester(new Application($this->client->getKernel())->find('app:oauth:bootstrap-clients'));
        $tester->execute([]);
        $tester->assertCommandIsSuccessful();
    }

    protected function createUser(string $email, string $name = 'Test User'): User
    {
        return static::getContainer()->get(UserProvisioner::class)->provision($email, $name, self::DEFAULT_PASSWORD);
    }

    /**
     * Signs the user in through /oauth/authorize and returns the request headers for API calls: as the web app, or as
     * another of our own apps ($clientId `desktop` or `mobile`).
     *
     * @param list<string> $scopes
     *
     * @return array<string, string>
     */
    protected function userHeaders(string $email, array $scopes, string $clientId = 'web'): array
    {
        $verifier = bin2hex(random_bytes(32));
        $redirectUri = 'web' === $clientId ? $this->webRedirectUri() : $this->nativeRedirectUri();

        $this->client->getCookieJar()->clear();
        $crawler = $this->client->request('GET', '/login');
        $this->client->submit($crawler->selectButton('Sign in')->form(['_username' => $email, '_password' => self::DEFAULT_PASSWORD]));

        $this->client->request('GET', '/oauth/authorize?'.http_build_query([
            'response_type' => 'code',
            'client_id' => $clientId,
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
            'client_id' => $clientId,
            'redirect_uri' => $redirectUri,
            'code' => $code,
            'code_verifier' => $verifier,
        ]);
        self::assertResponseIsSuccessful();
        $this->client->getCookieJar()->clear();

        return $this->bearerHeaders($this->decodedResponse()['access_token'] ?? null);
    }

    /**
     * @return array<string, string>
     */
    protected function workerHeaders(string $scope): array
    {
        $secret = $_SERVER['SYNC_WORKER_CLIENT_SECRET'] ?? null;
        self::assertIsString($secret);

        $this->client->request('POST', '/oauth/token', [
            'grant_type' => 'client_credentials',
            'client_id' => 'sync-worker',
            'client_secret' => $secret,
            'scope' => $scope,
        ]);
        self::assertResponseIsSuccessful();

        return $this->bearerHeaders($this->decodedResponse()['access_token'] ?? null);
    }

    /**
     * The body of the last response; changes with every request.
     *
     * @phpstan-impure
     *
     * @return array<mixed>
     */
    protected function decodedResponse(): array
    {
        $decoded = json_decode((string) $this->client->getResponse()->getContent(), true, flags: \JSON_THROW_ON_ERROR);
        self::assertIsArray($decoded);

        return $decoded;
    }

    /**
     * @phpstan-impure
     */
    protected function responseString(string $field): string
    {
        $value = $this->decodedResponse()[$field] ?? null;
        self::assertIsString($value, \sprintf('Response field "%s" is not a string.', $field));

        return $value;
    }

    /** @return array<string, string> */
    private function bearerHeaders(mixed $token): array
    {
        self::assertIsString($token);

        return ['HTTP_AUTHORIZATION' => 'Bearer '.$token, 'HTTP_ACCEPT' => 'application/json'];
    }

    private function webRedirectUri(): string
    {
        $webAppUrl = $_SERVER['WEB_APP_URL'] ?? null;
        self::assertIsString($webAppUrl);

        return rtrim($webAppUrl, '/').'/auth/callback';
    }

    /** Where the desktop and mobile apps get their authorization code. */
    private function nativeRedirectUri(): string
    {
        $uri = $_SERVER['NATIVE_REDIRECT_URI'] ?? null;
        self::assertIsString($uri);

        return $uri;
    }
}
