<?php

declare(strict_types=1);

namespace App\Tests\Functional;

use App\Security\OAuth\RefreshTokenRotation;
use App\Service\UserProvisioner;
use Doctrine\ORM\EntityManagerInterface;
use Symfony\Bundle\FrameworkBundle\Console\Application;
use Symfony\Component\DomCrawler\Field\ChoiceFormField;
use Symfony\Component\HttpFoundation\Request;
use Symfony\Component\HttpFoundation\RateLimiter\RequestRateLimiterInterface;
use Symfony\Component\Security\Http\SecurityRequestAttributes;
use Symfony\Component\Clock\Test\ClockSensitiveTrait;
use Symfony\Component\Console\Tester\CommandTester;

/**
 * The first-party sign-in as the web app performs it: authorization code with PKCE, browser login, token exchange,
 * then an authenticated API call.
 */
final class SignInFlowTest extends DatabaseTestCase
{
    use ClockSensitiveTrait;

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

        // The login limits outlive a test (they are not in the database); start every test without failed attempts.
        $limiter = static::getContainer()->get('security.login_throttling.main.limiter');
        self::assertInstanceOf(RequestRateLimiterInterface::class, $limiter);
        $request = Request::create('/login', 'POST', server: ['REMOTE_ADDR' => '127.0.0.1']);
        $request->attributes->set(SecurityRequestAttributes::LAST_USERNAME, self::EMAIL);
        $limiter->reset($request);
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

    public function testWrongPasswordsLockTheFormForAWhile(): void
    {
        for ($attempt = 1; $attempt <= 5; ++$attempt) {
            $this->signIn(password: 'wrong-'.$attempt);
            $this->client->followRedirect();
            self::assertSelectorTextContains('.error', 'Invalid credentials', 'Attempt '.$attempt);
        }

        $this->signIn();
        $this->client->followRedirect();

        self::assertSelectorTextContains('.error', 'Too many failed login attempts');
        self::assertSame('http://localhost/login', $this->authorize(), 'Even the right password is refused for now.');
    }

    public function testKeepMeSignedInSignsTheBrowserInAgainAfterTheSession(): void
    {
        $this->signIn();
        self::assertNotNull($this->client->getCookieJar()->get('REMEMBERME'), 'Keep me signed in is on by default.');

        $this->dropSession();

        self::assertStringStartsWith($this->webRedirectUri().'?', $this->authorize(), 'The remember-me cookie signs the browser in again.');
    }

    public function testWithoutKeepMeSignedInTheSignInEndsWithTheSession(): void
    {
        $this->signIn(rememberMe: false);
        self::assertNull($this->client->getCookieJar()->get('REMEMBERME'));
        self::assertStringStartsWith($this->webRedirectUri().'?', $this->authorize());

        $this->dropSession();

        self::assertSame('http://localhost/login', $this->authorize());
    }

    public function testAPasswordChangeEndsTheRememberedSignIn(): void
    {
        $this->signIn();
        $this->connection()->executeStatement("UPDATE app_user SET password = 'another-hash' WHERE email = :email", ['email' => self::EMAIL]);
        static::getContainer()->get(EntityManagerInterface::class)->clear();
        $this->dropSession();

        self::assertSame('http://localhost/login', $this->authorize());
    }

    public function testTheSignOutLinkOnlyShowsAPage(): void
    {
        $this->signIn();

        $crawler = $this->client->request('GET', '/logout');

        self::assertResponseIsSuccessful();
        self::assertSelectorTextContains('h1', 'Sign out');
        self::assertResponseHeaderSame('X-Frame-Options', 'DENY');
        self::assertResponseHeaderSame('Referrer-Policy', 'same-origin');
        self::assertSame(1, $crawler->filter('form[method="post"][action="/logout"]')->count());
        self::assertStringStartsWith($this->webRedirectUri().'?', $this->authorize(), 'Still signed in.');
    }

    public function testTheSignOutPageSignsOut(): void
    {
        $this->signIn();

        $crawler = $this->client->request('GET', '/logout');
        $this->client->submit($crawler->selectButton('Sign out')->form());

        self::assertResponseRedirects($this->webAppUrl());
        self::assertNull($this->client->getCookieJar()->get('REMEMBERME'), 'The remember-me cookie is cleared.');
        self::assertSame('http://localhost/login', $this->authorize());
    }

    public function testTheWebAppSignsOutWithAFormPost(): void
    {
        $this->signIn();

        $this->client->request('POST', '/logout', server: ['HTTP_ORIGIN' => $this->webAppUrl()]);

        self::assertResponseRedirects($this->webAppUrl());
        self::assertSame('http://localhost/login', $this->authorize());
    }

    public function testAnotherSiteCannotSignPeopleOut(): void
    {
        $this->signIn();

        $this->client->request('POST', '/logout', server: ['HTTP_ORIGIN' => 'https://evil.example']);
        self::assertResponseStatusCodeSame(403);
        $this->client->request('POST', '/logout', ['_csrf_token' => 'guessed']);
        self::assertResponseStatusCodeSame(403);
        $this->client->request('POST', '/logout', server: ['HTTP_ORIGIN' => 'null']);
        self::assertResponseStatusCodeSame(403);

        self::assertStringStartsWith($this->webRedirectUri().'?', $this->authorize(), 'Still signed in.');
    }

    public function testSignOutWithoutASignInGoesBackToTheApp(): void
    {
        $this->client->request('GET', '/logout');

        self::assertResponseRedirects($this->webAppUrl());
    }

    public function testRevokingTheRefreshTokenEndsTheSignIn(): void
    {
        $tokens = $this->tokens();

        $this->revoke($tokens['refresh_token'], 'refresh_token');

        self::assertResponseStatusCodeSame(200);
        self::assertSame('', $this->client->getResponse()->getContent());
        self::assertResponseHeaderSame('Cache-Control', 'no-store, private');
        $this->refresh($tokens['refresh_token']);
        self::assertResponseStatusCodeSame(400);
        self::assertSame('invalid_grant', $this->json()['error'] ?? null);
        $this->me($tokens['access_token']);
        self::assertResponseStatusCodeSame(401, 'The access token issued with it is revoked too.');
    }

    public function testRevokingTheAccessTokenEndsItsRefreshTokenToo(): void
    {
        $tokens = $this->tokens();

        $this->revoke($tokens['access_token'], 'access_token');

        self::assertResponseStatusCodeSame(200);
        $this->me($tokens['access_token']);
        self::assertResponseStatusCodeSame(401);
        $this->refresh($tokens['refresh_token']);
        self::assertSame('invalid_grant', $this->json()['error'] ?? null);
    }

    public function testRevocationWorksWithoutAHintAndTellsNothing(): void
    {
        $tokens = $this->tokens();

        $this->revoke('not-a-token', null);
        self::assertResponseStatusCodeSame(200);
        $this->revoke($tokens['refresh_token'], 'access_token');
        self::assertResponseStatusCodeSame(200, 'A wrong hint only changes where the server looks first.');
        $this->refresh($tokens['refresh_token']);
        self::assertSame('invalid_grant', $this->json()['error'] ?? null);
    }

    public function testOnlyTheClientATokenWasIssuedToCanRevokeIt(): void
    {
        $tokens = $this->tokens();

        $this->revoke($tokens['refresh_token'], 'refresh_token', 'desktop');

        self::assertResponseStatusCodeSame(200, 'The answer says nothing about the token.');
        $this->refresh($tokens['refresh_token']);
        self::assertResponseIsSuccessful();
    }

    public function testARevocationNeedsATokenAndAClient(): void
    {
        $this->client->request('POST', '/oauth/revoke', ['client_id' => 'web']);
        self::assertResponseStatusCodeSame(400);
        self::assertSame('invalid_request', $this->json()['error'] ?? null);

        $this->client->request('POST', '/oauth/revoke', ['token' => 'something']);
        self::assertResponseStatusCodeSame(400);
    }

    public function testARefreshTokenThatJustRotatedGetsTheSameAnswerAgain(): void
    {
        $tokens = $this->tokens();
        $this->refresh($tokens['refresh_token']);
        self::assertResponseIsSuccessful();
        $rotated = $this->json();

        $this->refresh($tokens['refresh_token']);

        self::assertResponseIsSuccessful();
        $again = $this->json();
        self::assertSame($rotated['refresh_token'] ?? null, $again['refresh_token'] ?? null, 'No second token family.');
        self::assertSame($rotated['access_token'] ?? null, $again['access_token'] ?? null);
        self::assertIsInt($again['expires_in'] ?? null);
        self::assertLessThanOrEqual(3600, $again['expires_in']);
        self::assertTrue($this->client->getResponse()->headers->hasCacheControlDirective('no-store'));
        $this->me($tokens['access_token']);
        self::assertResponseIsSuccessful('A request already sent with the old access token still goes through.');
    }

    public function testTheGraceOfARotatedRefreshTokenEnds(): void
    {
        $tokens = $this->tokens();
        $this->refresh($tokens['refresh_token']);
        $rotated = $this->json();

        self::mockTime('+'.(RefreshTokenRotation::GRACE_SECONDS + 1).' seconds');

        $this->refresh($tokens['refresh_token']);
        self::assertResponseStatusCodeSame(400);
        self::assertSame('invalid_grant', $this->json()['error'] ?? null);
        $this->me($tokens['access_token']);
        self::assertResponseStatusCodeSame(401);
        $this->refresh(self::string($rotated['refresh_token'] ?? null));
        self::assertResponseIsSuccessful('The new token is unaffected.');
    }

    public function testUsingTheNewRefreshTokenEndsTheGraceOfTheOldOne(): void
    {
        $tokens = $this->tokens();
        $this->refresh($tokens['refresh_token']);
        $rotated = $this->json();
        $this->refresh(self::string($rotated['refresh_token'] ?? null));
        self::assertResponseIsSuccessful();

        $this->refresh($tokens['refresh_token']);

        self::assertSame('invalid_grant', $this->json()['error'] ?? null);
        $this->me($tokens['access_token']);
        self::assertResponseStatusCodeSame(401);
    }

    public function testRevokingEndsTheGraceAtOnce(): void
    {
        $tokens = $this->tokens();
        $this->refresh($tokens['refresh_token']);
        $rotated = $this->json();

        $this->revoke(self::string($rotated['refresh_token'] ?? null), 'refresh_token');

        $this->refresh($tokens['refresh_token']);
        self::assertSame('invalid_grant', $this->json()['error'] ?? null);
        $this->me($tokens['access_token']);
        self::assertResponseStatusCodeSame(401);
    }

    public function testRevokingTheOldTokenAlsoEndsWhatItJustRotatedInto(): void
    {
        $tokens = $this->tokens();
        $this->refresh($tokens['refresh_token']);
        $lost = $this->json();

        $this->revoke($tokens['refresh_token'], 'refresh_token');

        $this->refresh(self::string($lost['refresh_token'] ?? null));
        self::assertSame('invalid_grant', $this->json()['error'] ?? null, 'The response that never arrived is revoked with it.');
        $this->me(self::string($lost['access_token'] ?? null));
        self::assertResponseStatusCodeSame(401);
    }

    /** @return array{access_token: string, refresh_token: string} */
    private function tokens(): array
    {
        $this->signIn();
        $verifier = bin2hex(random_bytes(32));
        $this->client->request('GET', '/oauth/authorize?'.http_build_query([
            'response_type' => 'code',
            'client_id' => 'web',
            'redirect_uri' => $this->webRedirectUri(),
            'scope' => 'mail:read',
            'state' => 's',
            'code_challenge' => rtrim(strtr(base64_encode(hash('sha256', $verifier, true)), '+/', '-_'), '='),
            'code_challenge_method' => 'S256',
        ]));
        parse_str((string) parse_url((string) $this->client->getResponse()->headers->get('Location'), \PHP_URL_QUERY), $query);
        $this->client->request('POST', '/oauth/token', [
            'grant_type' => 'authorization_code',
            'client_id' => 'web',
            'redirect_uri' => $this->webRedirectUri(),
            'code' => self::string($query['code'] ?? null),
            'code_verifier' => $verifier,
        ]);
        self::assertResponseIsSuccessful();
        $this->client->getCookieJar()->clear();
        $tokens = $this->json();

        return ['access_token' => self::string($tokens['access_token'] ?? null), 'refresh_token' => self::string($tokens['refresh_token'] ?? null)];
    }

    private function refresh(string $refreshToken): void
    {
        $this->client->request('POST', '/oauth/token', ['grant_type' => 'refresh_token', 'client_id' => 'web', 'refresh_token' => $refreshToken]);
    }

    private function revoke(string $token, ?string $hint, string $clientId = 'web'): void
    {
        $this->client->request('POST', '/oauth/revoke', array_filter(['token' => $token, 'token_type_hint' => $hint, 'client_id' => $clientId], static fn (?string $value): bool => null !== $value));
    }

    private function me(string $accessToken): void
    {
        $this->client->request('GET', '/api/v1/me', server: ['HTTP_AUTHORIZATION' => 'Bearer '.$accessToken, 'HTTP_ACCEPT' => 'application/json']);
    }

    private function signIn(bool $rememberMe = true, string $password = self::PASSWORD): void
    {
        $crawler = $this->client->request('GET', '/login');
        $form = $crawler->selectButton('Sign in')->form(['_username' => self::EMAIL, '_password' => $password]);
        if (!$rememberMe) {
            $checkbox = $form['_remember_me'];
            self::assertInstanceOf(ChoiceFormField::class, $checkbox);
            $checkbox->untick();
        }
        $this->client->submit($form);
    }

    /** The browser's session cookie is gone (it closed, or the session expired); other cookies stay. */
    private function dropSession(): void
    {
        // The name of the session cookie in tests (MockFileSessionStorage).
        $this->client->getCookieJar()->expire('MOCKSESSID');
        self::assertNull($this->client->getCookieJar()->get('MOCKSESSID'));
    }

    /** Where /oauth/authorize sends the browser for the web app: the callback with a code, or the sign-in page. */
    private function authorize(): string
    {
        $verifier = bin2hex(random_bytes(32));
        $this->client->request('GET', '/oauth/authorize?'.http_build_query([
            'response_type' => 'code',
            'client_id' => 'web',
            'redirect_uri' => $this->webRedirectUri(),
            'scope' => 'mail:read',
            'state' => 's',
            'code_challenge' => rtrim(strtr(base64_encode(hash('sha256', $verifier, true)), '+/', '-_'), '='),
            'code_challenge_method' => 'S256',
        ]));
        self::assertResponseRedirects();

        return (string) $this->client->getResponse()->headers->get('Location');
    }

    private function webAppUrl(): string
    {
        $webAppUrl = $_SERVER['WEB_APP_URL'] ?? null;
        \assert(\is_string($webAppUrl) && '' !== $webAppUrl);

        return rtrim($webAppUrl, '/');
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
