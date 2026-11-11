<?php

declare(strict_types=1);

namespace App\Tests\Functional;

use App\Entity\MailAccount;
use App\Entity\ProviderAuthorizationRequest;
use App\Entity\ProviderGrant;
use App\Realtime\MercureTokens;
use App\Tests\Support\RecordingMercureHub;

/**
 * Connecting Gmail and Microsoft 365 accounts through the providers' OAuth flow, with the token endpoints mocked.
 */
final class ProviderConnectTest extends DatabaseTestCase
{
    use AuthenticatesUsers;
    use ConnectsProviderAccounts;

    private const string WEB = 'http://localhost:5173';
    private const string DESKTOP = 'tresso://auth/callback';
    private const string GOOGLE_REVOKE = 'https://oauth2.googleapis.com/revoke';

    protected function setUp(): void
    {
        parent::setUp();
        $this->bootstrapOAuthClients();
        $this->createUser('kim@example.test', 'Kim Visser');
        $this->user = $this->userHeaders('kim@example.test', ['settings:read', 'settings:write']);
    }

    public function testConfiguredProvidersAreListed(): void
    {
        $this->client->request('GET', '/api/v1/oauth-providers', server: $this->user);

        self::assertResponseIsSuccessful();
        self::assertSame([
            ['id' => 'google', 'name' => 'Google', 'features' => ['mail', 'calendar']],
            ['id' => 'microsoft', 'name' => 'Microsoft', 'features' => ['mail', 'calendar']],
        ], $this->decodedResponse());
    }

    public function testStartReturnsTheProvidersAuthorizationUrlWithPkce(): void
    {
        $query = $this->start('google');

        self::assertSame('test-google-client', $query['client_id']);
        self::assertSame('http://localhost/connect/google/callback', $query['redirect_uri']);
        self::assertSame('code', $query['response_type']);
        self::assertSame('openid email profile '.self::GMAIL_SCOPE, $query['scope']);
        self::assertSame('S256', $query['code_challenge_method']);
        self::assertSame('offline', $query['access_type']);
        self::assertSame('consent', $query['prompt']);
        self::assertSame('true', $query['include_granted_scopes']);
        self::assertMatchesRegularExpression('/^[A-Za-z0-9_-]{43}$/', $query['state']);
        self::assertMatchesRegularExpression('/^[A-Za-z0-9_-]{43}$/', $query['code_challenge']);

        $stored = $this->entityManager()->find(ProviderAuthorizationRequest::class, hash('sha256', $query['state']));
        self::assertInstanceOf(ProviderAuthorizationRequest::class, $stored, 'Only the hash of the state is stored.');
        self::assertSame(
            $query['code_challenge'],
            rtrim(strtr(base64_encode(hash('sha256', $stored->getCodeVerifier(), true)), '+/', '-_'), '='),
        );
    }

    public function testMicrosoftAuthorizationAsksForGraphMailScopes(): void
    {
        $query = $this->start('microsoft');

        self::assertSame('test-microsoft-client', $query['client_id']);
        self::assertSame('openid email profile offline_access https://graph.microsoft.com/Mail.ReadWrite https://graph.microsoft.com/Mail.Send https://graph.microsoft.com/User.Read', $query['scope']);
        self::assertSame('query', $query['response_mode']);
        self::assertSame('select_account', $query['prompt']);
    }

    public function testStartValidatesItsInput(): void
    {
        $this->client->jsonRequest('POST', '/api/v1/provider-authorizations', ['provider' => 'yahoo'], $this->user);
        self::assertResponseStatusCodeSame(400);

        $this->client->jsonRequest('POST', '/api/v1/provider-authorizations', ['provider' => 'google', 'mailAccountId' => '0199f5e2-7c4e-7000-8000-000000000000'], $this->user);
        self::assertResponseStatusCodeSame(422);
        self::assertSame(['mailAccountId'], $this->violationPaths());

        $this->client->jsonRequest('POST', '/api/v1/provider-authorizations', ['provider' => 'google'], $this->workerHeaders('sync:lease'));
        self::assertResponseStatusCodeSame(403);
    }

    public function testGoogleSignInConnectsAGmailAccount(): void
    {
        $query = $this->start('google');
        $this->googleTokens();

        $location = $this->returnFromProvider('google', $query['state']);

        $account = $this->onlyAccount();
        self::assertSame(self::WEB.'/settings/accounts/new?provider=google&connected='.$account->getId()->toRfc4122(), $location);
        self::assertSame('kim@gmail.example', $account->getEmailAddress());
        self::assertSame('Kim Visser', $account->getDisplayName());
        self::assertSame('gmail', $account->getProvider()->value);
        self::assertNull($account->getEncryptedCredentials());

        $token = $this->router()->requestsTo(self::GOOGLE_TOKEN)[0] ?? null;
        self::assertNotNull($token);
        parse_str($token['body'], $body);
        self::assertSame('authorization_code', $body['grant_type'] ?? null);
        self::assertSame('code-1', $body['code'] ?? null);
        self::assertSame('http://localhost/connect/google/callback', $body['redirect_uri'] ?? null);
        self::assertSame('test-google-client', $body['client_id'] ?? null);
        self::assertSame('test-google-secret', $body['client_secret'] ?? null);
        $verifier = $body['code_verifier'] ?? null;
        self::assertIsString($verifier);
        self::assertSame($query['code_challenge'], rtrim(strtr(base64_encode(hash('sha256', $verifier, true)), '+/', '-_'), '='));

        $grant = $account->getProviderGrant();
        self::assertInstanceOf(ProviderGrant::class, $grant);
        self::assertSame('google-sub-1', $grant->getSubject());
        self::assertContains(self::GMAIL_SCOPE, $grant->getScopes());
        self::assertStringNotContainsString('google-refresh-1', $grant->getEncryptedTokens(), 'Tokens are sealed.');
        self::assertSame('google-refresh-1', $this->vault()->openGrant($grant)['refreshToken'] ?? null);

        $this->client->request('GET', '/api/v1/mail-accounts/'.$account->getId()->toRfc4122(), server: $this->user);
        self::assertResponseIsSuccessful();
        $resource = $this->decodedResponse();
        self::assertSame('gmail', $resource['provider'] ?? null);
        foreach (['imap', 'smtp', 'username'] as $field) {
            self::assertArrayHasKey($field, $resource);
            self::assertNull($resource[$field], $field.' is null for provider accounts.');
        }
        self::assertSame(0, $this->entityManager()->getRepository(ProviderAuthorizationRequest::class)->count([]), 'The state works once.');
    }

    public function testMicrosoftSignInConnectsAMicrosoftAccount(): void
    {
        $query = $this->start('microsoft');
        $this->router()->respond(self::MICROSOFT_TOKEN, (string) json_encode([
            'token_type' => 'Bearer',
            'access_token' => 'ms-access-1',
            'expires_in' => 3600,
            'refresh_token' => 'ms-refresh-1',
            // Microsoft answers with short scope names for Graph.
            'scope' => 'Mail.ReadWrite Mail.Send User.Read openid profile email',
            'id_token' => $this->idToken(['aud' => 'test-microsoft-client', 'tid' => 'tenant-1', 'oid' => 'object-1', 'sub' => 'pairwise']),
        ]));
        $this->router()->respond(self::GRAPH_ME, (string) json_encode(['mail' => 'Kim@Contoso.example', 'userPrincipalName' => 'kim@contoso.onmicrosoft.example', 'displayName' => 'Kim at Contoso']));

        $location = $this->returnFromProvider('microsoft', $query['state']);

        $account = $this->onlyAccount();
        self::assertSame(self::WEB.'/settings/accounts/new?provider=microsoft&connected='.$account->getId()->toRfc4122(), $location);
        self::assertSame('kim@contoso.example', $account->getEmailAddress());
        self::assertSame('Kim at Contoso', $account->getDisplayName());
        self::assertSame('microsoft', $account->getProvider()->value);
        $grant = $account->getProviderGrant();
        self::assertInstanceOf(ProviderGrant::class, $grant);
        self::assertSame('tenant-1:object-1', $grant->getSubject());
        self::assertSame(['email', 'mail.readwrite', 'mail.send', 'openid', 'profile', 'user.read'], $grant->getScopes());

        parse_str($this->router()->requestsTo(self::MICROSOFT_TOKEN)[0]['body'] ?? '', $body);
        $scope = $body['scope'] ?? null;
        self::assertIsString($scope);
        self::assertStringContainsString('https://graph.microsoft.com/Mail.ReadWrite', $scope);
        $me = $this->router()->requestsTo(self::GRAPH_ME)[0] ?? null;
        self::assertNotNull($me);
        self::assertContains('Authorization: Bearer ms-access-1', $me['headers']);
    }

    public function testAStateWorksOnce(): void
    {
        $query = $this->start('google');
        $this->googleTokens();
        $this->returnFromProvider('google', $query['state']);

        $location = $this->returnFromProvider('google', $query['state'], 'code-2');

        self::assertSame(self::WEB.'/settings/accounts/new?provider=google&connectError=expired', $location);
        self::assertCount(1, $this->router()->requestsTo(self::GOOGLE_TOKEN), 'A replayed callback never reaches the provider.');
    }

    public function testExpiredOrForeignStatesAreRefused(): void
    {
        $query = $this->start('google');
        $this->googleTokens();
        $this->connection()->executeStatement("UPDATE provider_authorization_request SET expires_at = now() - interval '1 minute'");

        self::assertSame(self::WEB.'/settings/accounts/new?provider=google&connectError=expired', $this->returnFromProvider('google', $query['state']));
        self::assertSame(self::WEB.'/settings/accounts/new?provider=google&connectError=expired', $this->returnFromProvider('google', 'made-up-state'));

        $microsoft = $this->start('microsoft');
        self::assertSame(self::WEB.'/settings/accounts/new?provider=google&connectError=expired', $this->returnFromProvider('google', $microsoft['state']), 'A state is only valid for its provider.');
        self::assertSame([], $this->router()->requestsTo(self::GOOGLE_TOKEN));
        self::assertSame(0, $this->entityManager()->getRepository(MailAccount::class)->count([]));
    }

    public function testOnlyTheUserWhoStartedCanFinish(): void
    {
        $query = $this->start('google');
        $this->googleTokens();
        $this->createUser('mallory@example.test', 'Mallory');

        // Someone else's browser opens the link: the account must not land in Kim's Tresso.
        $location = $this->returnFromProvider('google', $query['state'], finishAs: 'mallory@example.test');

        self::assertSame(self::WEB.'/settings/accounts/new?provider=google&connectError=different_user', $location);
        self::assertSame(0, $this->entityManager()->getRepository(MailAccount::class)->count([]));
        self::assertSame([], $this->router()->requestsTo(self::GOOGLE_TOKEN));

        $this->returnFromProvider('google', $query['state']);

        self::assertSame('kim@gmail.example', $this->onlyAccount()->getEmailAddress(), 'Mallory handing the answer in first did not cancel Kim\'s sign-in.');
    }

    public function testAnAnswerIsHandedInOnce(): void
    {
        $query = $this->start('google');
        $this->googleTokens();
        $answer = $this->providerRedirect('google', ['state' => $query['state'], 'code' => 'code-1']);

        $this->client->jsonRequest('POST', '/api/v1/provider-connections', $this->connectionInput($answer['query']), $this->user);
        self::assertResponseStatusCodeSame(200);
        $this->client->jsonRequest('POST', '/api/v1/provider-connections', $this->connectionInput($answer['query']), $this->user);

        self::assertResponseStatusCodeSame(200);
        self::assertSame('expired', $this->decodedResponse()['connectError'] ?? null);
        self::assertCount(1, $this->router()->requestsTo(self::GOOGLE_TOKEN), 'A replayed answer never reaches the provider.');
        $this->onlyAccount();
    }

    /**
     * Regression: the callback used to need the API's browser session, which ends long before the web app's sign-in
     * does. Back from Google or Microsoft, users then landed on Tresso's sign-in page as if they had been signed out.
     */
    public function testTheCallbackNeedsNoBrowserSession(): void
    {
        $query = $this->start('google');
        $this->googleTokens();

        $answer = $this->providerRedirect('google', ['state' => $query['state'], 'code' => 'code-1', 'scope' => 'ignored']);

        self::assertSame(self::WEB.'/settings/accounts/new?'.http_build_query(['provider' => 'google', 'state' => $query['state'], 'code' => 'code-1']), $answer['location'], 'Passed on to the web app, not to the sign-in page.');
        self::assertResponseHeaderSame('Referrer-Policy', 'no-referrer');
        self::assertResponseHeaderSame('Cache-Control', 'no-store, private');
        self::assertSame([], $this->client->getCookieJar()->all(), 'No session is started.');
        self::assertSame([], $this->router()->requestsTo(self::GOOGLE_TOKEN), 'Nothing is redeemed before the web app hands the answer in.');
        self::assertSame(1, $this->entityManager()->getRepository(ProviderAuthorizationRequest::class)->count([]));

        $this->client->jsonRequest('POST', '/api/v1/provider-connections', $this->connectionInput($answer['query']), $this->user);

        self::assertResponseStatusCodeSame(200);
        $account = $this->onlyAccount();
        self::assertSame(['provider' => 'google', 'connected' => $account->getId()->toRfc4122(), 'grant' => null, 'connectError' => null, 'requested' => ['mail'], 'missing' => [], 'existing' => false, 'approvalUrl' => null], $this->decodedResponse());
        self::assertSame(0, $this->entityManager()->getRepository(ProviderAuthorizationRequest::class)->count([]), 'The state works once.');
    }

    /**
     * Regression: the desktop app sent its own window to the provider, and the callback then took it to the web app,
     * another origin without the desktop app's tokens, so the user looked signed out. The desktop app opens the
     * provider in the system browser instead, and the answer comes back through the desktop app's link.
     */
    public function testADesktopSignInReturnsToTheDesktopApp(): void
    {
        $query = $this->start('google', returnTo: 'native');
        $this->googleTokens();

        $answer = $this->providerRedirect('google', ['state' => $query['state'], 'code' => 'code-1', 'scope' => 'ignored']);

        self::assertSame(self::DESKTOP.'?'.http_build_query(['next' => '/settings/accounts/new', 'provider' => 'google', 'state' => $query['state'], 'code' => 'code-1']), $answer['location']);
        self::assertResponseHeaderSame('Referrer-Policy', 'no-referrer');
        self::assertResponseHeaderSame('Cache-Control', 'no-store, private');
        self::assertSame([], $this->router()->requestsTo(self::GOOGLE_TOKEN), 'Nothing is redeemed before the desktop app hands the answer in.');

        $this->client->jsonRequest('POST', '/api/v1/provider-connections', $this->connectionInput($answer['query']), $this->user);

        self::assertResponseStatusCodeSame(200);
        $account = $this->onlyAccount();
        self::assertSame(['provider' => 'google', 'connected' => $account->getId()->toRfc4122(), 'grant' => null, 'connectError' => null, 'requested' => ['mail'], 'missing' => [], 'existing' => false, 'approvalUrl' => null], $this->decodedResponse());
        self::assertSame('kim@gmail.example', $account->getEmailAddress());
    }

    public function testSigningInAgainFromTheDesktopReturnsToItsAccountsPage(): void
    {
        $id = $this->connectGoogle()->getId()->toRfc4122();

        $query = $this->start('google', $id, returnTo: 'native');
        $this->googleTokens(access: 'google-access-2', refresh: 'google-refresh-2');

        $answer = $this->providerRedirect('google', ['state' => $query['state'], 'code' => 'code-2']);
        self::assertSame(self::DESKTOP.'?'.http_build_query(['next' => '/settings/accounts', 'provider' => 'google', 'state' => $query['state'], 'code' => 'code-2']), $answer['location']);

        self::assertSame(self::DESKTOP.'?provider=google&connected='.$id, $this->returnFromProvider('google', $query['state'], 'code-2'));
    }

    public function testAnExpiredDesktopSignInSaysSoInTheDesktopApp(): void
    {
        $query = $this->start('google', returnTo: 'native');
        $this->connection()->executeStatement("UPDATE provider_authorization_request SET expires_at = now() - interval '1 minute'");

        $answer = $this->providerRedirect('google', ['state' => $query['state'], 'code' => 'code-1']);

        self::assertSame(self::DESKTOP.'?'.http_build_query(['next' => '/settings/accounts/new', 'provider' => 'google', 'connectError' => 'expired']), $answer['location']);
        self::assertSame([], $this->router()->requestsTo(self::GOOGLE_TOKEN));
    }

    public function testTheReturnTargetIsOnlyWebOrNative(): void
    {
        $this->client->jsonRequest('POST', '/api/v1/provider-authorizations', ['provider' => 'google', 'returnTo' => 'https://attacker.example/steal'], $this->user);
        self::assertResponseStatusCodeSame(400);

        $this->client->jsonRequest('POST', '/api/v1/provider-authorizations', ['provider' => 'google', 'returnTo' => 'tresso://elsewhere'], $this->user);
        self::assertResponseStatusCodeSame(400);
        self::assertSame(0, $this->entityManager()->getRepository(ProviderAuthorizationRequest::class)->count([]));

        $query = $this->start('google', returnTo: 'web');
        $answer = $this->providerRedirect('google', ['state' => $query['state'], 'code' => 'code-1']);
        self::assertStringStartsWith(self::WEB.'/settings/accounts/new?', $answer['location']);
    }

    public function testRefusingAtTheProviderSaysSo(): void
    {
        $query = $this->start('google', features: ['mail', 'calendar']);

        $answer = $this->providerRedirect('google', ['state' => $query['state'], 'error' => 'access_denied', 'error_description' => 'The user said no.']);
        self::assertSame(self::WEB.'/settings/accounts/new?'.http_build_query(['provider' => 'google', 'state' => $query['state'], 'error' => 'access_denied', 'error_description' => 'The user said no.']), $answer['location']);

        $this->client->jsonRequest('POST', '/api/v1/provider-connections', $this->connectionInput($answer['query']), $this->user);
        self::assertResponseStatusCodeSame(200);
        $response = $this->decodedResponse();
        self::assertSame('denied', $response['connectError'] ?? null);
        self::assertSame(['mail', 'calendar'], $response['requested'] ?? null, 'Says what was asked for, so the client can offer mail alone.');
        self::assertNull($response['approvalUrl'] ?? 'missing');
        self::assertSame(0, $this->entityManager()->getRepository(ProviderAuthorizationRequest::class)->count([]));
    }

    public function testAWorkAccountWhoseOrganizationMustApproveSaysSoWithTheApprovalLink(): void
    {
        $this->client->jsonRequest('POST', '/api/v1/provider-authorizations', ['provider' => 'microsoft', 'emailAddress' => 'Kim@Company.example', 'features' => ['mail', 'calendar']], $this->user);
        self::assertResponseStatusCodeSame(201);
        parse_str((string) parse_url($this->responseString('authorizationUrl'), \PHP_URL_QUERY), $query);
        self::assertIsString($query['state'] ?? null);

        $answer = $this->providerRedirect('microsoft', [
            'state' => $query['state'],
            'error' => 'access_denied',
            'error_description' => 'AADSTS90094: Admin consent is required for the permissions requested by this application.',
        ]);
        $this->client->jsonRequest('POST', '/api/v1/provider-connections', $this->connectionInput($answer['query']), $this->user);

        self::assertResponseStatusCodeSame(200);
        $response = $this->decodedResponse();
        self::assertSame('admin_approval_required', $response['connectError'] ?? null);
        self::assertSame(
            'https://login.microsoftonline.com/company.example/adminconsent?client_id=test-microsoft-client&redirect_uri=http%3A%2F%2Flocalhost%2Fconnect%2Fmicrosoft%2Fcallback',
            $response['approvalUrl'] ?? null,
        );
    }

    public function testConsentRequiredAtMicrosoftAlsoAsksForApproval(): void
    {
        $query = $this->start('microsoft');
        $answer = $this->providerRedirect('microsoft', ['state' => $query['state'], 'error' => 'consent_required']);
        $this->client->jsonRequest('POST', '/api/v1/provider-connections', $this->connectionInput($answer['query']), $this->user);

        self::assertSame('admin_approval_required', $this->decodedResponse()['connectError'] ?? null);
        self::assertStringStartsWith('https://login.microsoftonline.com/organizations/adminconsent?', (string) ($this->decodedResponse()['approvalUrl'] ?? ''), 'Without an address, any organization.');
    }

    public function testAnAdministratorsApprovalReturnsToTheConnectPage(): void
    {
        $answer = $this->providerRedirect('microsoft', ['admin_consent' => 'True', 'tenant' => '9188040d-6c67-4c5b-b112-36a304b66dad']);

        self::assertSame(self::WEB.'/settings/accounts/new?provider=microsoft&adminConsent=granted', $answer['location']);
    }

    public function testANewSignInPassesTheTypedAddressAsLoginHint(): void
    {
        $this->client->jsonRequest('POST', '/api/v1/provider-authorizations', ['provider' => 'google', 'emailAddress' => 'kim@gmail.example'], $this->user);
        self::assertResponseStatusCodeSame(201);
        parse_str((string) parse_url($this->responseString('authorizationUrl'), \PHP_URL_QUERY), $query);

        self::assertSame('kim@gmail.example', $query['login_hint'] ?? null);

        $this->client->jsonRequest('POST', '/api/v1/provider-authorizations', ['provider' => 'google', 'emailAddress' => 'not an address'], $this->user);
        self::assertResponseStatusCodeSame(422);
        self::assertSame(['emailAddress'], $this->violationPaths());
    }

    public function testANewSignInForAConnectedAddressSaysItWasConnectedAlready(): void
    {
        $id = $this->connectGoogle()->getId()->toRfc4122();

        $query = $this->start('google');
        $this->googleTokens(access: 'google-access-2', refresh: 'google-refresh-2');
        $answer = $this->providerRedirect('google', ['state' => $query['state'], 'code' => 'code-2']);
        $this->client->jsonRequest('POST', '/api/v1/provider-connections', $this->connectionInput($answer['query']), $this->user);

        $response = $this->decodedResponse();
        self::assertSame($id, $response['connected'] ?? null);
        self::assertTrue($response['existing'] ?? null);
        self::assertSame(1, $this->entityManager()->getRepository(MailAccount::class)->count([]));
    }

    public function testFinishingValidatesItsInput(): void
    {
        $this->client->jsonRequest('POST', '/api/v1/provider-connections', ['provider' => 'yahoo', 'state' => 'x'], $this->user);
        self::assertResponseStatusCodeSame(400);

        $this->client->jsonRequest('POST', '/api/v1/provider-connections', ['provider' => 'google', 'state' => ''], $this->user);
        self::assertResponseStatusCodeSame(422);
        self::assertSame(['state'], $this->violationPaths());

        $this->client->jsonRequest('POST', '/api/v1/provider-connections', ['provider' => 'google', 'state' => 'x'], $this->userHeaders('kim@example.test', ['settings:read']));
        self::assertResponseStatusCodeSame(403);
    }

    public function testUntickedMailPermissionIsRefused(): void
    {
        $query = $this->start('google');
        $this->googleTokens(scope: 'openid https://www.googleapis.com/auth/userinfo.email');

        self::assertSame(self::WEB.'/settings/accounts/new?provider=google&connectError=scopes_missing', $this->returnFromProvider('google', $query['state']));
        self::assertSame(0, $this->entityManager()->getRepository(MailAccount::class)->count([]));
        self::assertSame(0, $this->entityManager()->getRepository(ProviderGrant::class)->count([]));
    }

    public function testCalendarsLeftUntickedStillConnectTheMailAndSaySo(): void
    {
        $query = $this->start('google', features: ['mail', 'calendar']);
        $this->googleTokens();
        $answer = $this->providerRedirect('google', ['state' => $query['state'], 'code' => 'code-1']);
        $this->client->jsonRequest('POST', '/api/v1/provider-connections', $this->connectionInput($answer['query']), $this->user);

        $response = $this->decodedResponse();
        self::assertIsString($response['connected'] ?? null);
        self::assertSame(['mail', 'calendar'], $response['requested'] ?? null);
        self::assertSame(['calendar'], $response['missing'] ?? null);
        self::assertFalse($response['existing'] ?? null);
        $this->entityManager()->clear();
        $account = $this->onlyAccount();
        self::assertSame('not_granted', $account->getCalendarStatus()->value, 'Said at once, not only when the worker first asks.');
        self::assertSame('Tresso is not allowed to use the calendars of this account yet. Allow it by signing in with Google again.', $account->getCalendarStatusDetail());
        $grant = $account->getProviderGrant();
        self::assertInstanceOf(ProviderGrant::class, $grant);
        self::assertNotContains('https://www.googleapis.com/auth/calendar.events', $grant->getScopes());
    }

    public function testAllowedCalendarsAreNotMissing(): void
    {
        $query = $this->start('google', features: ['mail', 'calendar']);
        $this->googleTokens(scope: 'openid '.self::GMAIL_SCOPE.' '.self::GOOGLE_CALENDAR_SCOPES);
        $answer = $this->providerRedirect('google', ['state' => $query['state'], 'code' => 'code-1']);
        $this->client->jsonRequest('POST', '/api/v1/provider-connections', $this->connectionInput($answer['query']), $this->user);

        self::assertSame([], $this->decodedResponse()['missing'] ?? null);
        $this->entityManager()->clear();
        self::assertSame('unknown', $this->onlyAccount()->getCalendarStatus()->value);
    }

    public function testAllowingCalendarsLaterKeepsTheMailAndWakesTheWorker(): void
    {
        $account = $this->connectGoogle();
        $id = $account->getId()->toRfc4122();
        $this->connection()->executeStatement("UPDATE mail_account SET calendar_status = 'not_granted', calendar_status_detail = 'x'");

        $query = $this->start('google', $id, ['calendar']);
        self::assertSame('openid email profile '.self::GOOGLE_CALENDAR_SCOPES.' '.self::GMAIL_SCOPE, $query['scope'], 'Asks for what the account allows already, so the new token keeps serving mail.');
        $this->googleTokens(access: 'google-access-2', refresh: null, scope: 'openid '.self::GMAIL_SCOPE.' '.self::GOOGLE_CALENDAR_SCOPES);

        self::assertSame(self::WEB.'/settings/accounts?provider=google&connected='.$id, $this->returnFromProvider('google', $query['state'], 'code-2'));
        $account = $this->onlyAccount();
        self::assertSame('unknown', $account->getCalendarStatus()->value);
        self::assertSame('active', $account->getStatus()->value);
        $grant = $account->getProviderGrant();
        self::assertInstanceOf(ProviderGrant::class, $grant);
        self::assertContains('https://www.googleapis.com/auth/calendar.events', $grant->getScopes());
        self::assertSame('google-refresh-1', $this->vault()->openGrant($grant)['refreshToken'] ?? null, 'The refresh token Google did not repeat is kept.');
        $hub = static::getContainer()->get(RecordingMercureHub::class);
        self::assertInstanceOf(RecordingMercureHub::class, $hub);
        $woken = array_filter($hub->takePublished(), static fn (array $update): bool => MercureTokens::OUTBOX_TOPIC === $update['body']['topic']);
        self::assertSame([json_encode(['mailAccountId' => $id])], array_values(array_map(static fn (array $update): string => $update['body']['data'], $woken)));
    }

    public function testCalendarsAloneNeedAConnectedAccount(): void
    {
        $this->client->jsonRequest('POST', '/api/v1/provider-authorizations', ['provider' => 'google', 'features' => ['calendar']], $this->user);

        self::assertResponseStatusCodeSame(422);
        self::assertSame(['features'], $this->violationPaths());
    }

    public function testUnverifiedGoogleAddressIsRefused(): void
    {
        $query = $this->start('google');
        $this->googleTokens(claims: ['email_verified' => false]);

        self::assertSame(self::WEB.'/settings/accounts/new?provider=google&connectError=unverified_address', $this->returnFromProvider('google', $query['state']));
    }

    public function testIdTokenForAnotherAppIsRefused(): void
    {
        $query = $this->start('google');
        $this->googleTokens(claims: ['aud' => 'someone-elses-client']);

        self::assertSame(self::WEB.'/settings/accounts/new?provider=google&connectError=failed', $this->returnFromProvider('google', $query['state']));
        self::assertSame(0, $this->entityManager()->getRepository(MailAccount::class)->count([]));
    }

    public function testRefusedCodeAndProviderOutageAreReported(): void
    {
        $query = $this->start('google');
        $this->router()->respondOnce(self::GOOGLE_TOKEN, '{"error":"invalid_grant"}', 400);
        self::assertSame(self::WEB.'/settings/accounts/new?provider=google&connectError=expired', $this->returnFromProvider('google', $query['state']));

        $query = $this->start('google');
        $this->router()->respondOnce(self::GOOGLE_TOKEN, 'Service Unavailable', 503);
        self::assertSame(self::WEB.'/settings/accounts/new?provider=google&connectError=failed', $this->returnFromProvider('google', $query['state']));
    }

    public function testAnAddressConnectedWithAPasswordIsNotTakenOver(): void
    {
        $this->client->jsonRequest('POST', '/api/v1/mail-accounts', [
            'emailAddress' => 'kim@gmail.example',
            'displayName' => 'Gmail',
            'username' => 'kim@gmail.example',
            'password' => 'app-password',
            'imap' => ['host' => 'imap.gmail.example', 'port' => 993, 'security' => 'tls'],
            'smtp' => ['host' => 'smtp.gmail.example', 'port' => 465, 'security' => 'tls'],
        ], $this->user);
        self::assertResponseStatusCodeSame(201);

        $query = $this->start('google');
        $this->googleTokens();

        self::assertSame(self::WEB.'/settings/accounts/new?provider=google&connectError=already_connected', $this->returnFromProvider('google', $query['state']));
        self::assertSame('imap', $this->onlyAccount()->getProvider()->value);
    }

    public function testSigningInAgainRestoresAFailedAccount(): void
    {
        $account = $this->connectGoogle();
        $id = $account->getId()->toRfc4122();
        $this->connection()->executeStatement("UPDATE mail_account SET status = 'auth_failed', status_detail = 'x'");

        $query = $this->start('google', $id);
        self::assertSame('kim@gmail.example', $query['login_hint']);
        $this->googleTokens(access: 'google-access-2', refresh: 'google-refresh-2');

        self::assertSame(self::WEB.'/settings/accounts?provider=google&connected='.$id, $this->returnFromProvider('google', $query['state'], 'code-2'));
        $this->entityManager()->clear();
        $account = $this->onlyAccount();
        self::assertSame('active', $account->getStatus()->value);
        self::assertNull($account->getStatusDetail());
        $grant = $account->getProviderGrant();
        self::assertInstanceOf(ProviderGrant::class, $grant);
        self::assertSame('google-refresh-2', $this->vault()->openGrant($grant)['refreshToken'] ?? null);
        self::assertSame(1, $this->entityManager()->getRepository(ProviderGrant::class)->count([]));
    }

    public function testSigningInAgainWithAnotherProviderAccountIsRefused(): void
    {
        $id = $this->connectGoogle()->getId()->toRfc4122();

        $query = $this->start('google', $id);
        $this->googleTokens(claims: ['sub' => 'google-sub-2', 'email' => 'someone-else@gmail.example']);

        self::assertSame(self::WEB.'/settings/accounts?provider=google&connectError=wrong_account', $this->returnFromProvider('google', $query['state']));
        $this->entityManager()->clear();
        self::assertSame(1, $this->entityManager()->getRepository(ProviderGrant::class)->count([]));
    }

    public function testSigningInAgainKeepsAProviderWithoutANewRefreshToken(): void
    {
        $this->connectGoogle();
        $query = $this->start('google');
        $this->googleTokens(access: 'google-access-2', refresh: null);

        $this->returnFromProvider('google', $query['state'], 'code-2');

        $this->entityManager()->clear();
        $grant = $this->onlyAccount()->getProviderGrant();
        self::assertInstanceOf(ProviderGrant::class, $grant);
        $tokens = $this->vault()->openGrant($grant);
        self::assertSame('google-refresh-1', $tokens['refreshToken'] ?? null);
        self::assertSame('google-access-2', $tokens['accessToken'] ?? null);
    }

    public function testProviderAccountsHaveNoPasswordOrServersToChange(): void
    {
        $id = $this->connectGoogle()->getId()->toRfc4122();

        $this->client->request('PATCH', '/api/v1/mail-accounts/'.$id, server: $this->user + ['CONTENT_TYPE' => 'application/merge-patch+json'], content: (string) json_encode(['password' => 'x', 'imap' => ['host' => 'imap.example', 'port' => 993, 'security' => 'tls']]));
        self::assertResponseStatusCodeSame(422);
        self::assertSame(['password', 'imap'], $this->violationPaths());

        $this->client->request('PATCH', '/api/v1/mail-accounts/'.$id, server: $this->user + ['CONTENT_TYPE' => 'application/merge-patch+json'], content: (string) json_encode(['displayName' => 'Personal', 'status' => 'paused']));
        self::assertResponseIsSuccessful();
        self::assertSame('Personal', $this->decodedResponse()['displayName'] ?? null);
    }

    public function testRemovingTheLastAccountEndsTheGrant(): void
    {
        $id = $this->connectGoogle()->getId()->toRfc4122();
        $this->router()->respond(self::GOOGLE_REVOKE, '');

        $this->client->request('DELETE', '/api/v1/mail-accounts/'.$id, server: $this->user);

        self::assertResponseStatusCodeSame(204);
        self::assertSame(0, $this->entityManager()->getRepository(ProviderGrant::class)->count([]));
        $revoke = $this->router()->requestsTo(self::GOOGLE_REVOKE)[0] ?? null;
        self::assertNotNull($revoke);
        self::assertSame('token=google-refresh-1', $revoke['body']);
    }

    public function testRemovingAnAccountKeepsAGoogleAccountAnotherUserStillConnected(): void
    {
        $kimsAccount = $this->connectGoogle()->getId()->toRfc4122();
        $this->createUser('lisa@example.test', 'Lisa');
        $kim = $this->user;
        $this->user = $this->userHeaders('lisa@example.test', ['settings:read', 'settings:write']);
        $query = $this->start('google');
        $this->googleTokens(access: 'google-access-lisa', refresh: 'google-refresh-lisa');
        $this->returnFromProvider('google', $query['state'], 'code-lisa');
        self::assertSame(2, $this->entityManager()->getRepository(ProviderGrant::class)->count([]));
        $this->router()->respond(self::GOOGLE_REVOKE, '');

        $this->client->request('DELETE', '/api/v1/mail-accounts/'.$kimsAccount, server: $kim);

        self::assertResponseStatusCodeSame(204);
        self::assertSame([], $this->router()->requestsTo(self::GOOGLE_REVOKE), 'revoking would end Lisa\'s access too');
        self::assertSame(1, $this->entityManager()->getRepository(ProviderGrant::class)->count([]));
    }
}
