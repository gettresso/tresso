<?php

declare(strict_types=1);

namespace App\Tests\Functional;

use App\Security\OAuth\RegistrationLimits;
use Symfony\Bundle\FrameworkBundle\KernelBrowser;

/**
 * Tokens of callers that are not our own apps: an app that registered itself and was allowed on the consent screen,
 * and a personal access token. Needs {@see AuthenticatesUsers}.
 *
 * @property KernelBrowser $client
 */
trait ConnectsThirdPartyApps
{
    private const string THIRD_PARTY_REDIRECT = 'http://127.0.0.1:33418/callback';

    /**
     * Registers an app, signs the user in, allows the app on the consent screen and returns its request headers. An app
     * that wants a chat scope names its scopes when it registers, as it must; any other registers without.
     *
     * @param list<string> $scopes
     *
     * @return array<string, string>
     */
    protected function thirdPartyHeaders(string $email, array $scopes): array
    {
        $this->resetRegistrationLimits();
        $registration = ['client_name' => 'Some app', 'redirect_uris' => [self::THIRD_PARTY_REDIRECT]];
        if ([] !== array_intersect($scopes, ['chat:read', 'chat:send'])) {
            $registration['scope'] = implode(' ', $scopes);
        }
        $this->client->jsonRequest('POST', '/oauth/register', $registration);
        self::assertResponseStatusCodeSame(201);
        $clientId = $this->responseString('client_id');

        $verifier = bin2hex(random_bytes(32));
        $this->client->getCookieJar()->clear();
        $crawler = $this->client->request('GET', '/login');
        $this->client->submit($crawler->selectButton('Sign in')->form(['_username' => $email, '_password' => self::DEFAULT_PASSWORD]));
        $crawler = $this->client->request('GET', '/oauth/authorize?'.http_build_query([
            'response_type' => 'code',
            'client_id' => $clientId,
            'redirect_uri' => self::THIRD_PARTY_REDIRECT,
            'scope' => implode(' ', $scopes),
            'state' => 'test',
            'code_challenge' => rtrim(strtr(base64_encode(hash('sha256', $verifier, true)), '+/', '-_'), '='),
            'code_challenge_method' => 'S256',
        ]));
        self::assertResponseIsSuccessful('The consent screen is shown.');
        $this->client->submit($crawler->selectButton('Allow')->form());
        parse_str((string) parse_url((string) $this->client->getResponse()->headers->get('Location'), \PHP_URL_QUERY), $query);
        $code = $query['code'] ?? null;
        self::assertIsString($code, 'Allowing did not return a code.');

        $this->client->request('POST', '/oauth/token', [
            'grant_type' => 'authorization_code',
            'client_id' => $clientId,
            'redirect_uri' => self::THIRD_PARTY_REDIRECT,
            'code' => $code,
            'code_verifier' => $verifier,
        ]);
        self::assertResponseIsSuccessful();
        $this->client->getCookieJar()->clear();

        return ['HTTP_AUTHORIZATION' => 'Bearer '.$this->responseString('access_token'), 'HTTP_ACCEPT' => 'application/json'];
    }

    /**
     * Registration limits are kept between runs (in the filesystem in tests); start from none used.
     */
    protected function resetRegistrationLimits(string ...$addresses): void
    {
        static::getContainer()->get(RegistrationLimits::class)->reset('127.0.0.1', ...$addresses);
    }

    /**
     * Makes a personal access token with these scopes (through the web app) and returns its request headers.
     *
     * @param list<string> $scopes
     *
     * @return array<string, string>
     */
    protected function personalAccessTokenHeaders(string $email, array $scopes): array
    {
        $this->client->jsonRequest('POST', '/api/v1/personal-access-tokens', ['name' => 'Script', 'scopes' => $scopes], $this->userHeaders($email, array_values(array_unique([...$scopes, 'settings:write']))));
        self::assertResponseStatusCodeSame(201);

        return ['HTTP_AUTHORIZATION' => 'Bearer '.$this->responseString('token'), 'HTTP_ACCEPT' => 'application/json'];
    }
}
