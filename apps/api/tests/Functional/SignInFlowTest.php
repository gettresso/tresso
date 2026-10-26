<?php

declare(strict_types=1);

namespace App\Tests\Functional;

use App\Service\UserProvisioner;
use Symfony\Bundle\FrameworkBundle\Console\Application;
use Symfony\Component\Console\Tester\CommandTester;

/**
 * The first-party sign-in as the web app performs it: authorization code with PKCE, browser login, token exchange,
 * then an authenticated API call.
 */
final class SignInFlowTest extends DatabaseTestCase
{
    private const string EMAIL = 'kim@example.test';
    private const string PASSWORD = 'correct-horse-battery-staple';

    protected function setUp(): void
    {
        parent::setUp();

        $tester = new CommandTester(new Application($this->client->getKernel())->find('app:oauth:bootstrap-clients'));
        $tester->execute([]);
        $tester->assertCommandIsSuccessful();

        $provisioner = static::getContainer()->get(UserProvisioner::class);
        $provisioner->provision(self::EMAIL, 'Kim Visser', self::PASSWORD);
    }

    public function testMeRequiresToken(): void
    {
        $this->client->request('GET', '/api/v1/me', server: ['HTTP_ACCEPT' => 'application/json']);

        self::assertResponseStatusCodeSame(401);
    }

    public function testTheSignInPageCarriesTressosLookAndItsFilesExist(): void
    {
        $crawler = $this->client->request('GET', '/login');

        self::assertResponseIsSuccessful();
        self::assertSelectorTextContains('h1', 'Sign in');
        $public = self::string(static::getContainer()->getParameter('kernel.project_dir')).'/public';
        foreach (['link[rel="stylesheet"]' => 'href', 'link[rel="icon"]' => 'href'] as $selector => $attribute) {
            $path = self::string($crawler->filter($selector)->attr($attribute));
            self::assertFileExists($public.$path, $selector.' points at a file the server has.');
        }
        $css = self::string(file_get_contents($public.'/auth/auth.css'));
        preg_match_all("~url\\('([^']+)'\\)~", $css, $fonts);
        self::assertNotEmpty($fonts[1]);
        foreach ($fonts[1] as $font) {
            self::assertFileExists($public.'/auth/'.$font);
        }
    }

    public function testWebAppSignsInAndReadsMe(): void
    {
        $verifier = bin2hex(random_bytes(32));
        $challenge = rtrim(strtr(base64_encode(hash('sha256', $verifier, true)), '+/', '-_'), '=');
        $redirectUri = $this->webRedirectUri();

        $authorizeUrl = '/oauth/authorize?'.http_build_query([
            'response_type' => 'code',
            'client_id' => 'web',
            'redirect_uri' => $redirectUri,
            'scope' => 'mail:read todos:read',
            'state' => 'state-1',
            'code_challenge' => $challenge,
            'code_challenge_method' => 'S256',
        ]);

        $this->client->request('GET', $authorizeUrl);
        self::assertResponseRedirects('http://localhost/login');

        $crawler = $this->client->request('GET', '/login');
        $this->client->submit($crawler->selectButton('Sign in')->form([
            '_username' => self::EMAIL,
            '_password' => self::PASSWORD,
        ]));
        $this->client->followRedirect();

        $callback = (string) $this->client->getResponse()->headers->get('Location');
        self::assertStringStartsWith($redirectUri.'?', $callback, 'First-party clients are approved without consent.');
        parse_str((string) parse_url($callback, \PHP_URL_QUERY), $query);
        self::assertSame('state-1', $query['state'] ?? null);
        $code = $query['code'] ?? null;
        self::assertIsString($code);

        $this->client->request('POST', '/oauth/token', [
            'grant_type' => 'authorization_code',
            'client_id' => 'web',
            'redirect_uri' => $redirectUri,
            'code' => $code,
            'code_verifier' => $verifier,
        ]);
        self::assertResponseIsSuccessful();
        $token = $this->json();
        self::assertIsString($token['access_token'] ?? null);
        self::assertIsString($token['refresh_token'] ?? null);

        // The browser session from the login must not authenticate API calls; only the bearer token does.
        $this->client->getCookieJar()->clear();
        $this->client->request('GET', '/api/v1/me', server: [
            'HTTP_AUTHORIZATION' => 'Bearer '.$token['access_token'],
            'HTTP_ACCEPT' => 'application/json',
        ]);

        self::assertResponseIsSuccessful();
        $me = $this->json();
        self::assertSame(self::EMAIL, $me['email'] ?? null);
        self::assertSame('Kim Visser', $me['displayName'] ?? null);
        self::assertIsString($me['id'] ?? null);
        self::assertIsString($me['createdAt'] ?? null);
    }

    public function testPkceVerifierMustMatch(): void
    {
        $redirectUri = $this->webRedirectUri();
        $challenge = rtrim(strtr(base64_encode(hash('sha256', 'the-real-verifier-'.str_repeat('x', 30), true)), '+/', '-_'), '=');

        $crawler = $this->client->request('GET', '/login');
        $this->client->submit($crawler->selectButton('Sign in')->form(['_username' => self::EMAIL, '_password' => self::PASSWORD]));
        $this->client->request('GET', '/oauth/authorize?'.http_build_query([
            'response_type' => 'code',
            'client_id' => 'web',
            'redirect_uri' => $redirectUri,
            'scope' => 'mail:read',
            'state' => 's',
            'code_challenge' => $challenge,
            'code_challenge_method' => 'S256',
        ]));
        parse_str((string) parse_url((string) $this->client->getResponse()->headers->get('Location'), \PHP_URL_QUERY), $query);
        self::assertIsString($query['code'] ?? null);

        $this->client->request('POST', '/oauth/token', [
            'grant_type' => 'authorization_code',
            'client_id' => 'web',
            'redirect_uri' => $redirectUri,
            'code' => $query['code'],
            'code_verifier' => 'a-different-verifier-'.str_repeat('y', 30),
        ]);

        self::assertResponseStatusCodeSame(400);
        self::assertSame('invalid_grant', $this->json()['error'] ?? null);
    }

    private function webRedirectUri(): string
    {
        $webAppUrl = $_SERVER['WEB_APP_URL'] ?? null;
        \assert(\is_string($webAppUrl) && '' !== $webAppUrl);

        return rtrim($webAppUrl, '/').'/auth/callback';
    }

    /** @return array<mixed> */
    private function json(): array
    {
        $decoded = json_decode((string) $this->client->getResponse()->getContent(), true, flags: \JSON_THROW_ON_ERROR);
        \assert(\is_array($decoded));

        return $decoded;
    }

    private static function string(mixed $value): string
    {
        self::assertIsString($value);

        return $value;
    }
}
