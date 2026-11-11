<?php

declare(strict_types=1);

namespace App\Tests\Functional;

use App\Entity\MailAccount;
use App\Security\Crypto\CredentialVault;
use App\Tests\Support\MockHttpRouter;
use Doctrine\ORM\EntityManagerInterface;
use Symfony\Bundle\FrameworkBundle\KernelBrowser;

/**
 * Walks through a provider sign-in like a browser does, with the providers' endpoints answered by the mock router.
 * Needs {@see AuthenticatesUsers} and a signed-in user's API headers in $this->user.
 *
 * @property KernelBrowser $client
 */
trait ConnectsProviderAccounts
{
    private const string GOOGLE_TOKEN = 'https://oauth2.googleapis.com/token';
    private const string MICROSOFT_TOKEN = 'https://login.microsoftonline.com/common/oauth2/v2.0/token';
    private const string GRAPH_ME = 'https://graph.microsoft.com/v1.0/me';
    private const string GMAIL_SCOPE = 'https://www.googleapis.com/auth/gmail.modify';
    private const string GOOGLE_CALENDAR_SCOPES = 'https://www.googleapis.com/auth/calendar.events https://www.googleapis.com/auth/calendar.calendarlist.readonly';

    /** @var array<string, string> */
    private array $user;

    /**
     * Signs in with Google once and returns the new account.
     */
    private function connectGoogle(): MailAccount
    {
        $query = $this->start('google');
        $this->googleTokens();
        $this->returnFromProvider('google', $query['state']);

        return $this->onlyAccount();
    }

    /**
     * Starts a sign-in and returns the query of the authorization URL.
     *
     * @param list<string>|null $features null for the API's default
     * @param string|null       $returnTo null for the API's default (the web app)
     *
     * @return array<string, string>
     */
    private function start(string $provider, ?string $mailAccountId = null, ?array $features = null, ?string $returnTo = null): array
    {
        $this->client->jsonRequest('POST', '/api/v1/provider-authorizations', ['provider' => $provider] + (null === $mailAccountId ? [] : ['mailAccountId' => $mailAccountId]) + (null === $features ? [] : ['features' => $features]) + (null === $returnTo ? [] : ['returnTo' => $returnTo]), $this->user);
        self::assertResponseStatusCodeSame(201);
        $url = $this->responseString('authorizationUrl');
        self::assertSame($provider, $this->responseString('provider'));

        parse_str((string) parse_url($url, \PHP_URL_QUERY), $query);

        /** @var array<string, string> $query */
        return $query;
    }

    /**
     * The provider sends the browser back, and the web app finishes the sign-in as the web app does: the callback
     * passes the answer on (in a browser without an API session, the usual case once that session has ended), and the
     * web app hands it to the API with its access token. Returns the page the browser landed on, with the outcome the
     * web app learned there in its query (`connected`, `grant` or `connectError`), the way the web app reads it.
     *
     * @param string|null $finishAs whose web app finishes it; null for the signed-in user of the test ($this->user)
     */
    private function returnFromProvider(string $provider, string $state, string $code = 'code-1', ?string $finishAs = null): string
    {
        $headers = null === $finishAs ? $this->user : $this->userHeaders($finishAs, ['settings:read', 'settings:write']);

        $answer = $this->providerRedirect($provider, ['state' => $state, 'code' => $code, 'scope' => 'ignored']);
        if (!isset($answer['query']['state'])) {
            return $answer['location'];
        }

        $this->client->jsonRequest('POST', '/api/v1/provider-connections', $this->connectionInput($answer['query']), $headers);
        self::assertResponseStatusCodeSame(200);
        $response = $this->decodedResponse();
        $outcome = [];
        foreach (['connected', 'grant', 'connectError'] as $key) {
            if (\is_string($response[$key] ?? null)) {
                $outcome[$key] = $response[$key];
            }
        }
        $this->entityManager()->clear();

        return $answer['page'].'?'.http_build_query(['provider' => $provider, ...$outcome]);
    }

    /**
     * Opens the callback in a browser that is not signed in to the API and returns where it sent the browser.
     *
     * @param array<string, string> $query
     *
     * @return array{location: string, page: string, query: array<string, string>}
     */
    private function providerRedirect(string $provider, array $query): array
    {
        $this->client->getCookieJar()->clear();
        $this->client->request('GET', '/connect/'.$provider.'/callback?'.http_build_query($query));
        self::assertResponseStatusCodeSame(302);
        $location = $this->client->getResponse()->headers->get('Location');
        self::assertIsString($location);
        parse_str((string) parse_url($location, \PHP_URL_QUERY), $passedOn);

        /** @var array<string, string> $passedOn */
        return ['location' => $location, 'page' => explode('?', $location, 2)[0], 'query' => $passedOn];
    }

    /**
     * The body the web app posts to /api/v1/provider-connections for what the callback passed on.
     *
     * @param array<string, string> $passedOn
     *
     * @return array<string, string>
     */
    private function connectionInput(array $passedOn): array
    {
        $input = array_intersect_key($passedOn, array_flip(['provider', 'state', 'code', 'error']));
        if (isset($passedOn['error_description'])) {
            $input['errorDescription'] = $passedOn['error_description'];
        }

        return $input;
    }

    /**
     * @param array<string, mixed> $claims
     */
    private function googleTokens(string $access = 'google-access-1', ?string $refresh = 'google-refresh-1', ?string $scope = null, array $claims = []): void
    {
        $response = [
            'access_token' => $access,
            'expires_in' => 3599,
            'scope' => $scope ?? 'openid https://www.googleapis.com/auth/userinfo.email https://www.googleapis.com/auth/userinfo.profile '.self::GMAIL_SCOPE,
            'token_type' => 'Bearer',
            'id_token' => $this->idToken($claims + ['aud' => 'test-google-client', 'sub' => 'google-sub-1', 'email' => 'kim@gmail.example', 'email_verified' => true, 'name' => 'Kim Visser']),
        ];
        if (null !== $refresh) {
            $response['refresh_token'] = $refresh;
        }
        $this->router()->respond(self::GOOGLE_TOKEN, (string) json_encode($response));
    }

    /**
     * @param array<string, mixed> $claims
     */
    private function idToken(array $claims): string
    {
        $encode = static fn (array $part): string => rtrim(strtr(base64_encode((string) json_encode($part)), '+/', '-_'), '=');

        return $encode(['alg' => 'RS256', 'typ' => 'JWT']).'.'.$encode($claims + ['iat' => time(), 'exp' => time() + 3600]).'.signature';
    }

    /**
     * @return list<string> property paths of the last response's violations
     */
    private function violationPaths(): array
    {
        $violations = $this->decodedResponse()['violations'] ?? null;
        self::assertIsArray($violations);

        return array_values(array_map(static fn (mixed $violation): string => \is_array($violation) && \is_string($violation['propertyPath'] ?? null) ? $violation['propertyPath'] : '', $violations));
    }

    /**
     * The credentials part of a credentials response.
     *
     * @param array<string, mixed> $response
     *
     * @return array<string, mixed>
     */
    private static function secrets(array $response): array
    {
        $secrets = $response['credentials'] ?? null;
        self::assertIsArray($secrets);

        /** @var array<string, mixed> */
        return $secrets;
    }

    private function onlyAccount(): MailAccount
    {
        $accounts = $this->entityManager()->getRepository(MailAccount::class)->findAll();
        self::assertCount(1, $accounts);

        return $accounts[0];
    }

    private function router(): MockHttpRouter
    {
        return static::getContainer()->get(MockHttpRouter::class);
    }

    private function vault(): CredentialVault
    {
        return static::getContainer()->get(CredentialVault::class);
    }

    private function entityManager(): EntityManagerInterface
    {
        return static::getContainer()->get(EntityManagerInterface::class);
    }
}
