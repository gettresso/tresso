<?php

declare(strict_types=1);

namespace App\Tests\Functional;

use App\Account\Import\SweepMailAccountImports;
use App\Account\Import\SweepMailAccountImportsHandler;
use App\Account\UserDeletion;
use App\Entity\User;
use App\Security\Crypto\UserKeys;
use App\Storage\Reencryption;
use Symfony\Bundle\FrameworkBundle\Console\Application;
use Symfony\Component\Console\Tester\CommandTester;

/**
 * Mail account import lists: a list of addresses the user wants to add, made in Tresso's apps or by an app the user
 * allowed, which the user then connects one by one on the web app's page for it. Making one connects nothing and takes
 * no secret; it belongs to its user only and lives a day.
 */
final class MailAccountImportTest extends DatabaseTestCase
{
    use AuthenticatesUsers;
    use ConnectsProviderAccounts;
    use ConnectsThirdPartyApps;

    private const string WEB = 'http://localhost:5173';

    private User $kim;

    protected function setUp(): void
    {
        parent::setUp();
        $this->bootstrapOAuthClients();
        $this->kim = $this->createUser('kim@example.test', 'Kim Visser');
        $this->createUser('lisa@example.test', 'Lisa Bakker');
        $this->user = $this->userHeaders('kim@example.test', ['settings:read', 'settings:write']);
    }

    public function testAListIsMadeWithEachAddressThatCanBeAddedAndSaysWhichWereLeftOut(): void
    {
        $this->createImapAccount('kim@company.example');

        $list = $this->createList([
            ['address' => ' Anna@Partner.example ', 'provider' => 'google'],
            ['address' => 'not an address'],
            ['address' => 'anna@partner.example'],
            ['address' => 'KIM@company.example'],
            ['address' => 'kim@outlook.example', 'provider' => 'microsoft'],
        ]);

        self::assertResponseStatusCodeSame(201);
        $id = self::string($list['id'] ?? null);
        self::assertSame([
            ['address' => 'anna@partner.example', 'provider' => 'google', 'state' => 'todo'],
            ['address' => 'kim@outlook.example', 'provider' => 'microsoft', 'state' => 'todo'],
        ], self::entrySummaries($list));
        self::assertSame([
            ['address' => 'not an address', 'reason' => 'invalid', 'message' => 'This is not an email address.'],
            ['address' => 'anna@partner.example', 'reason' => 'duplicate', 'message' => 'This address is in the list already.'],
            ['address' => 'kim@company.example', 'reason' => 'already_connected', 'message' => 'This address is connected already.'],
        ], $list['leftOut'] ?? null);
        self::assertSame(['todo' => 2, 'connected' => 0, 'already_connected' => 0, 'failed' => 0, 'skipped' => 0], $list['progress'] ?? null);
        self::assertSame(self::WEB.'/settings/accounts/import/'.$id, $list['pageUrl'] ?? null);
        self::assertArrayHasKey('createdBy', $list);
        self::assertNull($list['createdBy'], 'Made in Tresso itself: no app to name.');
        self::assertEqualsWithDelta(new \DateTimeImmutable('+24 hours'), new \DateTimeImmutable(self::string($list['expiresAt'] ?? null)), 60);

        $row = $this->connection()->fetchAssociative('SELECT * FROM mail_account_import WHERE id = ?', [$id]);
        self::assertIsArray($row);
        $stored = implode(' ', array_map(static fn (mixed $value): string => \is_scalar($value) ? (string) $value : '', $row));
        self::assertStringNotContainsString('partner.example', $stored, 'Addresses are sealed at rest.');
        self::assertStringNotContainsString('outlook.example', $stored);
        self::assertStringStartsWith('f1.', self::string($row['sealed_entries']));

        $this->client->request('GET', '/api/v1/mail-account-imports/'.$id, server: $this->user);
        self::assertResponseIsSuccessful();
        self::assertSame(self::entrySummaries($list), self::entrySummaries($this->decodedResponse()));
        self::assertSame([], $this->decodedResponse()['leftOut'] ?? null, 'What was left out is only said when the list is made.');
    }

    public function testAListWithNothingToTakeIsRefusedPerAddress(): void
    {
        $this->createImapAccount('kim@company.example');

        $this->createList([['address' => 'kim@company.example'], ['address' => 'nope']]);

        self::assertResponseStatusCodeSame(422);
        self::assertSame(['entries[0].address', 'entries[1].address'], $this->violationPaths());
        self::assertSame(0, $this->countRows('SELECT COUNT(*) FROM mail_account_import'));
    }

    public function testAListHoldsAtMostFiftyAddresses(): void
    {
        $this->createList(self::addresses(51));
        self::assertResponseStatusCodeSame(422);
        self::assertSame(['entries'], $this->violationPaths());

        $this->createList([]);
        self::assertResponseStatusCodeSame(422);

        $list = $this->createList(self::addresses(50));
        self::assertResponseStatusCodeSame(201);
        self::assertCount(50, self::asList($list['entries'] ?? null));
    }

    public function testNoPasswordCodeOrTokenIsTakenAnywhere(): void
    {
        foreach ([
            ['entries' => [['address' => 'anna@partner.example', 'password' => 'hunter2']]],
            ['entries' => [['address' => 'anna@partner.example']], 'password' => 'hunter2'],
            ['entries' => [['address' => 'anna@partner.example', 'appPassword' => 'abcd-efgh']]],
            ['entries' => [['address' => 'anna@partner.example', 'code' => '123456']]],
            ['entries' => [['address' => 'anna@partner.example']], 'token' => 'ya29.secret'],
        ] as $body) {
            $this->client->jsonRequest('POST', '/api/v1/mail-account-imports', $body, $this->user);
            self::assertResponseStatusCodeSame(400, (string) json_encode($body));
            self::assertStringNotContainsString('hunter2', (string) $this->client->getResponse()->getContent());
        }
        self::assertSame(0, $this->countRows('SELECT COUNT(*) FROM mail_account_import'));

        $id = self::string($this->createList([['address' => 'anna@partner.example']])['id'] ?? null);
        $entry = $this->entryId($id, 'anna@partner.example');
        $this->client->jsonRequest('POST', '/api/v1/mail-account-imports/'.$id.'/entry-states', ['entryId' => $entry, 'state' => 'failed', 'failure' => 'password_refused', 'password' => 'hunter2'], $this->user);
        self::assertResponseStatusCodeSame(400);
        $this->client->jsonRequest('POST', '/api/v1/mail-account-imports/'.$id.'/entry-states', ['entryId' => $entry, 'state' => 'failed', 'failure' => 'The password hunter2 was refused'], $this->user);
        self::assertGreaterThanOrEqual(400, $this->client->getResponse()->getStatusCode(), 'A reason is a code, never text.');
        self::assertSame('todo', $this->entryState($id, 'anna@partner.example'));
    }

    public function testAnAppTheUserAllowedMakesAListThatNamesIt(): void
    {
        $app = $this->thirdPartyHeaders('kim@example.test', ['settings:read', 'settings:write']);
        $this->client->jsonRequest('POST', '/api/v1/mail-account-imports', ['entries' => [['address' => 'anna@partner.example']]], $app);
        self::assertResponseStatusCodeSame(201);
        self::assertSame('Some app', $this->decodedResponse()['createdBy'] ?? null);
        self::assertFalse($this->decodedResponse()['createdWithToken'] ?? null);

        $token = $this->personalAccessTokenHeaders('kim@example.test', ['settings:write']);
        $this->client->jsonRequest('POST', '/api/v1/mail-account-imports', ['entries' => [['address' => 'anna@partner.example']]], $token);
        self::assertResponseStatusCodeSame(201);
        self::assertSame('your access token "Script"', $this->decodedResponse()['createdBy'] ?? null);
        self::assertTrue($this->decodedResponse()['createdWithToken'] ?? null);
    }

    public function testMakingAListNeedsSettingsWriteAndReadingItSettingsRead(): void
    {
        $id = self::string($this->createList([['address' => 'anna@partner.example']])['id'] ?? null);

        $readOnly = $this->userHeaders('kim@example.test', ['settings:read']);
        $this->client->jsonRequest('POST', '/api/v1/mail-account-imports', ['entries' => [['address' => 'bob@partner.example']]], $readOnly);
        self::assertResponseStatusCodeSame(403);
        $this->client->jsonRequest('POST', '/api/v1/mail-account-imports/'.$id.'/entry-states', ['entryId' => $this->entryId($id, 'anna@partner.example'), 'state' => 'skipped'], $readOnly);
        self::assertResponseStatusCodeSame(403);
        $this->client->request('DELETE', '/api/v1/mail-account-imports/'.$id, server: $readOnly);
        self::assertResponseStatusCodeSame(403);

        $mailOnly = $this->userHeaders('kim@example.test', ['mail:read']);
        $this->client->request('GET', '/api/v1/mail-account-imports/'.$id, server: $mailOnly);
        self::assertResponseStatusCodeSame(403);
        $this->client->request('GET', '/api/v1/mail-account-imports/'.$id, server: $readOnly);
        self::assertResponseIsSuccessful();
    }

    public function testAnotherUsersListDoesNotExistForThem(): void
    {
        $id = self::string($this->createList([['address' => 'anna@partner.example']])['id'] ?? null);
        $entry = $this->entryId($id, 'anna@partner.example');
        $lisa = $this->userHeaders('lisa@example.test', ['settings:read', 'settings:write']);

        $this->client->request('GET', '/api/v1/mail-account-imports/'.$id, server: $lisa);
        self::assertResponseStatusCodeSame(404);
        $this->client->request('GET', '/api/v1/mail-account-imports', server: $lisa);
        self::assertSame([], $this->decodedResponse());
        $this->client->jsonRequest('POST', '/api/v1/mail-account-imports/'.$id.'/entry-states', ['entryId' => $entry, 'state' => 'skipped'], $lisa);
        self::assertResponseStatusCodeSame(404);
        $this->client->request('DELETE', '/api/v1/mail-account-imports/'.$id, server: $lisa);
        self::assertResponseStatusCodeSame(404);

        self::assertSame('todo', $this->entryState($id, 'anna@partner.example'));
        $this->client->request('GET', '/api/v1/mail-account-imports', server: $this->user);
        self::assertSame([$id], array_column(self::asList($this->decodedResponse()), 'id'));
    }

    public function testAListExpiresAfterADayAndIsSweptAway(): void
    {
        $id = self::string($this->createList([['address' => 'anna@partner.example']])['id'] ?? null);
        $other = self::string($this->createList([['address' => 'bob@partner.example']])['id'] ?? null);
        $this->connection()->executeStatement("UPDATE mail_account_import SET expires_at = NOW() - INTERVAL '1 minute' WHERE id = ?", [$id]);

        $this->client->request('GET', '/api/v1/mail-account-imports/'.$id, server: $this->user);
        self::assertResponseStatusCodeSame(404);
        $this->client->request('GET', '/api/v1/mail-account-imports', server: $this->user);
        self::assertSame([$other], array_column(self::asList($this->decodedResponse()), 'id'));

        self::assertSame(1, static::getContainer()->get(SweepMailAccountImportsHandler::class)(new SweepMailAccountImports()));
        self::assertSame([$other], $this->connection()->fetchFirstColumn('SELECT id FROM mail_account_import'));
    }

    public function testAUserHasAtMostTwentyListsAtATime(): void
    {
        for ($i = 0; $i < 20; ++$i) {
            $this->createList([['address' => "person{$i}@partner.example"]]);
            self::assertResponseStatusCodeSame(201);
        }

        $this->createList([['address' => 'one-more@partner.example']]);
        self::assertResponseStatusCodeSame(409);
    }

    public function testAnAccountAddedAnotherWayIsAlreadyConnectedAndOneAddedFromTheListConnected(): void
    {
        $id = self::string($this->createList([['address' => 'kim@company.example'], ['address' => 'anna@partner.example'], ['address' => 'bob@partner.example']])['id'] ?? null);
        $anna = $this->entryId($id, 'anna@partner.example');

        $account = $this->createImapAccount('kim@company.example');
        $this->markEntry($id, ['entryId' => $anna, 'state' => 'connected']);
        self::assertResponseStatusCodeSame(422, 'Connected is only taken for an address that has its account.');
        self::assertSame(['state'], $this->violationPaths());

        // The page's server form created the account, then says it came from the list.
        $this->createImapAccount('anna@partner.example');
        $this->markEntry($id, ['entryId' => $anna, 'state' => 'connected']);
        self::assertResponseIsSuccessful();

        $list = $this->readList($id);
        self::assertSame(['already_connected', 'connected', 'todo'], array_column(self::asList($list['entries'] ?? null), 'state'));
        self::assertSame($account, self::asList($list['entries'] ?? null)[0]['mailAccountId'] ?? null);
        self::assertSame('active', self::asList($list['entries'] ?? null)[0]['accountStatus'] ?? null);
        self::assertSame(['todo' => 1, 'connected' => 1, 'already_connected' => 1, 'failed' => 0, 'skipped' => 0], $list['progress'] ?? null);

        $this->markEntry($id, ['entryId' => $anna, 'state' => 'already_connected']);
        self::assertResponseStatusCodeSame(422);
    }

    public function testEntriesAreSkippedFailedAndSetBack(): void
    {
        $id = self::string($this->createList([['address' => 'anna@partner.example'], ['address' => 'bob@partner.example']])['id'] ?? null);
        $anna = $this->entryId($id, 'anna@partner.example');
        $bob = $this->entryId($id, 'bob@partner.example');

        $this->markEntry($id, ['entryId' => $anna, 'state' => 'skipped']);
        self::assertResponseIsSuccessful();
        self::assertSame(['todo' => 1, 'connected' => 0, 'already_connected' => 0, 'failed' => 0, 'skipped' => 1], $this->decodedResponse()['progress'] ?? null);

        $this->markEntry($id, ['entryId' => $bob, 'state' => 'failed', 'failure' => 'password_refused']);
        self::assertResponseIsSuccessful();
        $entry = self::asList($this->decodedResponse()['entries'] ?? null)[1];
        self::assertSame(['failed', 'password_refused', 'The mail server did not accept the username or password.'], [$entry['state'] ?? null, $entry['failure'] ?? null, $entry['reason'] ?? null]);

        $this->markEntry($id, ['entryId' => $anna, 'state' => 'todo']);
        $this->markEntry($id, ['entryId' => $bob, 'state' => 'todo']);
        self::assertSame(['todo', 'todo'], array_column(self::asList($this->decodedResponse()['entries'] ?? null), 'state'));
        self::assertNull(self::asList($this->decodedResponse()['entries'] ?? null)[1]['failure'] ?? null);

        $this->markEntry($id, ['entryId' => $anna, 'state' => 'connected']);
        self::assertResponseStatusCodeSame(422, 'Not connected without its account.');
        $this->markEntry($id, ['entryId' => $anna, 'state' => 'skipped', 'failure' => 'denied']);
        self::assertResponseStatusCodeSame(422);
        self::assertSame(['failure'], $this->violationPaths());
        $this->markEntry($id, ['entryId' => '0193a1b2-c3d4-7e5f-8a9b-0c1d2e3f4a5b', 'state' => 'skipped']);
        self::assertResponseStatusCodeSame(422);
        self::assertSame(['entryId'], $this->violationPaths());
    }

    public function testAListIsDeleted(): void
    {
        $id = self::string($this->createList([['address' => 'anna@partner.example']])['id'] ?? null);

        $this->client->request('DELETE', '/api/v1/mail-account-imports/'.$id, server: $this->user);
        self::assertResponseStatusCodeSame(204);

        $this->client->request('GET', '/api/v1/mail-account-imports/'.$id, server: $this->user);
        self::assertResponseStatusCodeSame(404);
        self::assertSame(0, $this->countRows('SELECT COUNT(*) FROM mail_account_import'));
    }

    public function testASignInForAnAddressOfTheListComesBackToTheListAndConnectsIt(): void
    {
        $id = self::string($this->createList([['address' => 'kim@gmail.example'], ['address' => 'anna@partner.example']])['id'] ?? null);

        $query = $this->startForList('google', $id, 'Kim@Gmail.example');
        self::assertSame('kim@gmail.example', $query['login_hint'], 'The provider starts with the address of the row.');
        $this->googleTokens();
        $page = $this->returnFromProvider('google', $query['state']);

        self::assertStringStartsWith(self::WEB.'/settings/accounts/import/'.$id.'?', $page, 'The answer comes back to the list.');
        self::assertStringContainsString('connected=', $page);
        self::assertSame('connected', $this->entryState($id, 'kim@gmail.example'));
        self::assertSame('todo', $this->entryState($id, 'anna@partner.example'));
    }

    public function testAMicrosoftRowConnectsWithItsCalendarsAndComesBackToTheList(): void
    {
        $id = self::string($this->createList([['address' => 'kim@contoso.example', 'provider' => 'microsoft']])['id'] ?? null);

        $this->client->jsonRequest('POST', '/api/v1/provider-authorizations', ['provider' => 'microsoft', 'emailAddress' => 'kim@contoso.example', 'importId' => $id, 'features' => ['mail', 'calendar']], $this->user);
        self::assertResponseStatusCodeSame(201);
        parse_str((string) parse_url($this->responseString('authorizationUrl'), \PHP_URL_QUERY), $query);
        self::assertSame('kim@contoso.example', $query['login_hint'] ?? null);
        self::assertIsString($query['state'] ?? null);
        $this->router()->respond(self::MICROSOFT_TOKEN, (string) json_encode([
            'token_type' => 'Bearer',
            'access_token' => 'ms-access-1',
            'expires_in' => 3600,
            'refresh_token' => 'ms-refresh-1',
            'scope' => 'Mail.ReadWrite Mail.Send User.Read Calendars.ReadWrite openid profile email',
            'id_token' => $this->idToken(['aud' => 'test-microsoft-client', 'tid' => 'tenant-1', 'oid' => 'object-1', 'sub' => 'pairwise']),
        ]));
        $this->router()->respond(self::GRAPH_ME, (string) json_encode(['mail' => 'Kim@Contoso.example', 'userPrincipalName' => 'kim@contoso.onmicrosoft.example', 'displayName' => 'Kim at Contoso']));

        $page = $this->returnFromProvider('microsoft', $query['state']);

        self::assertStringStartsWith(self::WEB.'/settings/accounts/import/'.$id.'?provider=microsoft&connected=', $page);
        self::assertSame('connected', $this->entryState($id, 'kim@contoso.example'));
    }

    public function testAGoogleRowMayAllowCalendarsToo(): void
    {
        $id = self::string($this->createList([['address' => 'kim@gmail.example']])['id'] ?? null);

        $this->client->jsonRequest('POST', '/api/v1/provider-authorizations', ['provider' => 'google', 'emailAddress' => 'kim@gmail.example', 'importId' => $id, 'features' => ['mail', 'calendar']], $this->user);
        self::assertResponseStatusCodeSame(201);
        parse_str((string) parse_url($this->responseString('authorizationUrl'), \PHP_URL_QUERY), $query);
        self::assertIsString($query['state'] ?? null);
        $this->googleTokens(scope: 'openid '.self::GMAIL_SCOPE.' '.self::GOOGLE_CALENDAR_SCOPES);

        $this->returnFromProvider('google', $query['state']);

        self::assertSame('connected', $this->entryState($id, 'kim@gmail.example'));
        self::assertSame('unknown', $this->connection()->fetchOne('SELECT calendar_status FROM mail_account'), 'Calendars wait for the worker to list them.');
    }

    public function testTheDesktopAppGetsTheListPageInItsLink(): void
    {
        $id = self::string($this->createList([['address' => 'kim@gmail.example']])['id'] ?? null);
        $desktop = $this->userHeaders('kim@example.test', ['settings:read', 'settings:write'], 'desktop');

        $this->client->jsonRequest('POST', '/api/v1/provider-authorizations', ['provider' => 'google', 'emailAddress' => 'kim@gmail.example', 'importId' => $id, 'returnTo' => 'native'], $desktop);
        self::assertResponseStatusCodeSame(201);
        parse_str((string) parse_url($this->responseString('authorizationUrl'), \PHP_URL_QUERY), $query);
        self::assertIsString($query['state'] ?? null);

        $answer = $this->providerRedirect('google', ['state' => $query['state'], 'code' => 'code-1']);
        self::assertStringStartsWith('tresso://auth/callback?', $answer['location']);
        self::assertSame('/settings/accounts/import/'.$id, $answer['query']['next'] ?? null);
    }

    public function testSigningInWithAnotherAccountThanTheRowConnectsNothingAndSaysWhy(): void
    {
        $id = self::string($this->createList([['address' => 'kim@gmail.example']])['id'] ?? null);

        $query = $this->startForList('google', $id, 'kim@gmail.example');
        $this->googleTokens(claims: ['email' => 'someone-else@gmail.example', 'sub' => 'google-sub-2']);
        $page = $this->returnFromProvider('google', $query['state']);

        self::assertStringContainsString('connectError=wrong_account', $page);
        self::assertSame(0, $this->countRows('SELECT COUNT(*) FROM mail_account'), 'Nothing is connected for an address the user did not start.');
        $entry = $this->entry($id, 'kim@gmail.example');
        self::assertSame(['failed', 'wrong_account'], [$entry['state'] ?? null, $entry['failure'] ?? null]);

        // Trying again and succeeding clears the failure.
        $query = $this->startForList('google', $id, 'kim@gmail.example');
        $this->googleTokens();
        $this->returnFromProvider('google', $query['state']);
        self::assertSame('connected', $this->entryState($id, 'kim@gmail.example'));
    }

    public function testARefusedSignInIsRecordedOnTheRow(): void
    {
        $id = self::string($this->createList([['address' => 'kim@gmail.example']])['id'] ?? null);
        $query = $this->startForList('google', $id, 'kim@gmail.example');

        $answer = $this->providerRedirect('google', ['state' => $query['state'], 'error' => 'access_denied']);
        $this->client->jsonRequest('POST', '/api/v1/provider-connections', $this->connectionInput($answer['query']), $this->user);
        self::assertResponseStatusCodeSame(200);
        self::assertSame('denied', $this->decodedResponse()['connectError'] ?? null);

        $entry = $this->entry($id, 'kim@gmail.example');
        self::assertSame(['failed', 'denied'], [$entry['state'] ?? null, $entry['failure'] ?? null]);
        self::assertNull($entry['approvalUrl'] ?? null);
    }

    public function testAnOrganizationThatMustApproveTresssoGivesTheRowTheApprovalLink(): void
    {
        $id = self::string($this->createList([['address' => 'kim@contoso.example']])['id'] ?? null);
        $query = $this->startForList('microsoft', $id, 'kim@contoso.example');

        $answer = $this->providerRedirect('microsoft', ['state' => $query['state'], 'error' => 'consent_required']);
        $this->client->jsonRequest('POST', '/api/v1/provider-connections', $this->connectionInput($answer['query']), $this->user);
        self::assertSame('admin_approval_required', $this->decodedResponse()['connectError'] ?? null);

        $entry = $this->entry($id, 'kim@contoso.example');
        self::assertSame(['failed', 'admin_approval_required'], [$entry['state'] ?? null, $entry['failure'] ?? null]);
        self::assertStringStartsWith('https://login.microsoftonline.com/contoso.example/adminconsent?', self::string($entry['approvalUrl'] ?? null));
    }

    public function testASignInForTheListNeedsAnAddressOfTheList(): void
    {
        $id = self::string($this->createList([['address' => 'kim@gmail.example']])['id'] ?? null);
        $lisasList = self::string($this->createList([['address' => 'lisa@gmail.example']], $this->userHeaders('lisa@example.test', ['settings:write']))['id'] ?? null);

        foreach ([
            ['provider' => 'google', 'emailAddress' => 'other@gmail.example', 'importId' => $id],
            ['provider' => 'google', 'importId' => $id],
            ['provider' => 'google', 'emailAddress' => 'lisa@gmail.example', 'importId' => $lisasList],
        ] as $body) {
            $this->client->jsonRequest('POST', '/api/v1/provider-authorizations', $body, $this->user);
            self::assertResponseStatusCodeSame(422, (string) json_encode($body));
            self::assertSame(['importId'], $this->violationPaths());
        }
    }

    public function testOnlyTresssosOwnAppsStartASignInEvenForAList(): void
    {
        $app = $this->thirdPartyHeaders('kim@example.test', ['settings:read', 'settings:write']);
        $this->client->jsonRequest('POST', '/api/v1/mail-account-imports', ['entries' => [['address' => 'kim@gmail.example']]], $app);
        self::assertResponseStatusCodeSame(201);
        $id = $this->responseString('id');

        $this->client->jsonRequest('POST', '/api/v1/provider-authorizations', ['provider' => 'google', 'emailAddress' => 'kim@gmail.example', 'importId' => $id], $app);
        self::assertResponseStatusCodeSame(403);
        $this->client->jsonRequest('POST', '/api/v1/mail-accounts', ['emailAddress' => 'kim@gmail.example', 'displayName' => 'Kim', 'username' => 'kim@gmail.example', 'password' => 'x', 'imap' => ['host' => 'imap.gmail.example', 'port' => 993, 'security' => 'tls'], 'smtp' => ['host' => 'smtp.gmail.example', 'port' => 465, 'security' => 'tls']], $app);
        self::assertResponseStatusCodeSame(403);
        self::assertSame(0, $this->countRows('SELECT COUNT(*) FROM provider_authorization_request'));
    }

    public function testAKeyRotationResealsTheListAndItStillReads(): void
    {
        $id = self::string($this->createList([['address' => 'anna@partner.example']])['id'] ?? null);

        $tester = new CommandTester(new Application($this->client->getKernel())->find('app:crypto:rotate-user-keys'));
        $tester->execute(['--user' => ['kim@example.test']]);
        $tester->assertCommandIsSuccessful();
        static::getContainer()->get(UserKeys::class)->reset();
        $reencryption = static::getContainer()->get(Reencryption::class);
        self::assertSame(1, $reencryption->remaining($this->kim->getId())['importLists']);

        $result = $reencryption->run($this->kim->getId(), 10, static function (): void {});

        self::assertSame(0, $result->failed);
        self::assertSame(0, $reencryption->remaining($this->kim->getId())['importLists']);
        self::assertStringStartsWith('f1.2.', self::string($this->connection()->fetchOne('SELECT sealed_entries FROM mail_account_import WHERE id = ?', [$id])));
        self::assertSame('todo', $this->entryState($id, 'anna@partner.example'));
    }

    public function testAListAnAppMadeLeavesOutLookalikeAddressesAndOneMadeInTresssoStoresTheDomainInAscii(): void
    {
        $app = $this->thirdPartyHeaders('kim@example.test', ['settings:read', 'settings:write']);
        $list = $this->createList([
            ['address' => 'kim@gmaіl.com'],
            ['address' => 'kіm@company.example'],
            ['address' => 'kim@müller.de'],
            ['address' => 'kim+news@gmail.com'],
            ['address' => 'k.i.m@sub.mail.example'],
        ], $app);
        self::assertResponseStatusCodeSame(201);
        self::assertSame(['kim+news@gmail.com', 'k.i.m@sub.mail.example'], array_column(self::asList($list['entries'] ?? null), 'address'));
        self::assertSame(['lookalike', 'lookalike', 'lookalike'], array_column(self::asList($list['leftOut'] ?? null), 'reason'));
        self::assertSame('The address uses letters that look like other letters.', self::asList($list['leftOut'] ?? null)[0]['message'] ?? null);

        $mine = $this->createList([['address' => 'Kim@Gmaіl.com'], ['address' => 'kim@müller.de']]);
        self::assertSame(['kim@xn--gmal-n9d.com', 'kim@xn--mller-kva.de'], array_column(self::asList($mine['entries'] ?? null), 'address'));
    }

    public function testAddressesLongerThanAllowedAreLeftOut(): void
    {
        $list = $this->createList([
            ['address' => str_repeat('a', 64).'@company.example'],
            ['address' => str_repeat('a', 65).'@company.example'],
            ['address' => 'kim@'.str_repeat('a', 64).'.example'],
        ]);

        self::assertSame([str_repeat('a', 64).'@company.example'], array_column(self::asList($list['entries'] ?? null), 'address'));
        self::assertSame(['invalid', 'invalid'], array_column(self::asList($list['leftOut'] ?? null), 'reason'));
    }

    public function testOnlyTresssosOwnAppsMarkEntriesAndConfirmAList(): void
    {
        $id = self::string($this->createList([['address' => 'anna@partner.example']])['id'] ?? null);
        $entry = $this->entryId($id, 'anna@partner.example');
        $app = $this->thirdPartyHeaders('kim@example.test', ['settings:read', 'settings:write']);
        $token = $this->personalAccessTokenHeaders('kim@example.test', ['settings:read', 'settings:write']);

        foreach ([$app, $token] as $headers) {
            $this->client->jsonRequest('POST', '/api/v1/mail-account-imports/'.$id.'/entry-states', ['entryId' => $entry, 'state' => 'skipped'], $headers);
            self::assertResponseStatusCodeSame(403);
            $this->client->jsonRequest('POST', '/api/v1/mail-account-imports/'.$id.'/confirmation', [], $headers);
            self::assertResponseStatusCodeSame(403);
        }
        self::assertSame('todo', $this->entryState($id, 'anna@partner.example'));
    }

    public function testAnAppSeesFollowsAndDeletesOnlyTheListsItMade(): void
    {
        $mine = self::string($this->createList([['address' => 'anna@partner.example']])['id'] ?? null);
        $app = $this->thirdPartyHeaders('kim@example.test', ['settings:read', 'settings:write']);
        $made = self::string($this->createList([['address' => 'bob@partner.example']], $app)['id'] ?? null);
        $token = $this->personalAccessTokenHeaders('kim@example.test', ['settings:read', 'settings:write']);

        $this->client->request('GET', '/api/v1/mail-account-imports', server: $app);
        self::assertSame([$made], array_column(self::asList($this->decodedResponse()), 'id'));
        $this->client->request('GET', '/api/v1/mail-account-imports', server: $token);
        self::assertSame([], $this->decodedResponse());
        $this->client->request('GET', '/api/v1/mail-account-imports', server: $this->user);
        self::assertSame([$made, $mine], array_column(self::asList($this->decodedResponse()), 'id'), 'Tresso shows every list of the user.');

        $this->client->request('GET', '/api/v1/mail-account-imports/'.$mine, server: $app);
        self::assertResponseStatusCodeSame(404);
        $this->client->request('DELETE', '/api/v1/mail-account-imports/'.$mine, server: $app);
        self::assertResponseStatusCodeSame(404);
        $this->client->request('DELETE', '/api/v1/mail-account-imports/'.$made, server: $token);
        self::assertResponseStatusCodeSame(404);
        $this->client->request('DELETE', '/api/v1/mail-account-imports/'.$made, server: $app);
        self::assertResponseStatusCodeSame(204);
        self::assertSame([$mine], $this->connection()->fetchFirstColumn('SELECT id FROM mail_account_import'));
    }

    public function testAListAnAppMadeIsUsedOnlyOnceTheUserConfirmsIt(): void
    {
        self::assertTrue($this->createList([['address' => 'anna@partner.example']])['confirmed'] ?? null, 'Made in Tresso: nothing to confirm.');
        $app = $this->thirdPartyHeaders('kim@example.test', ['settings:read', 'settings:write']);
        $id = self::string($this->createList([['address' => 'bob@partner.example']], $app)['id'] ?? null);
        self::assertFalse($this->readList($id)['confirmed'] ?? null);

        $this->client->jsonRequest('POST', '/api/v1/mail-account-imports/'.$id.'/confirmation', [], $this->user);
        self::assertResponseIsSuccessful();
        self::assertTrue($this->decodedResponse()['confirmed'] ?? null);
        self::assertTrue($this->readList($id)['confirmed'] ?? null);
    }

    public function testTheCapCountsOnlyListsThatLive(): void
    {
        for ($i = 0; $i < 20; ++$i) {
            $this->createList([['address' => "person{$i}@partner.example"]]);
        }
        $this->connection()->executeStatement("UPDATE mail_account_import SET expires_at = NOW() - INTERVAL '1 minute' WHERE id = (SELECT id FROM mail_account_import ORDER BY created_at LIMIT 1)");

        $this->createList([['address' => 'one-more@partner.example']]);
        self::assertResponseStatusCodeSame(201);
        $this->createList([['address' => 'two-more@partner.example']]);
        self::assertResponseStatusCodeSame(409);
    }

    public function testDeletingTheUserDeletesTheirLists(): void
    {
        $this->createList([['address' => 'anna@partner.example']]);

        static::getContainer()->get(UserDeletion::class)->delete($this->kim->getId());

        self::assertSame(0, $this->countRows('SELECT COUNT(*) FROM mail_account_import'));
    }

    public function testAnExpiredListTakesNoSignInNoMarkAndNoOutcome(): void
    {
        $id = self::string($this->createList([['address' => 'kim@gmail.example']])['id'] ?? null);
        $entry = $this->entryId($id, 'kim@gmail.example');
        $query = $this->startForList('google', $id, 'kim@gmail.example');
        $this->connection()->executeStatement("UPDATE mail_account_import SET expires_at = NOW() - INTERVAL '1 minute'");

        $this->client->jsonRequest('POST', '/api/v1/provider-authorizations', ['provider' => 'google', 'emailAddress' => 'kim@gmail.example', 'importId' => $id], $this->user);
        self::assertResponseStatusCodeSame(422);
        $this->markEntry($id, ['entryId' => $entry, 'state' => 'skipped']);
        self::assertResponseStatusCodeSame(404);

        // The sign-in started before still connects the account; the expired list is left as it was.
        $this->googleTokens();
        $page = $this->returnFromProvider('google', $query['state']);
        self::assertStringContainsString('connected=', $page);
        // Nothing was written on the expired list: brought back to life, its row shows an account it did not add.
        $this->connection()->executeStatement("UPDATE mail_account_import SET expires_at = NOW() + INTERVAL '1 hour'");
        self::assertSame('already_connected', $this->entryState($id, 'kim@gmail.example'));
    }

    public function testASignInStartRefusesAnImportIdThatIsNoId(): void
    {
        $this->client->jsonRequest('POST', '/api/v1/provider-authorizations', ['provider' => 'google', 'emailAddress' => 'kim@gmail.example', 'importId' => 'not-a-list'], $this->user);

        self::assertResponseStatusCodeSame(422);
        self::assertSame(['importId'], $this->violationPaths());
    }

    public function testAListDeletedDuringASignInStillLetsTheSignInFinish(): void
    {
        $id = self::string($this->createList([['address' => 'kim@gmail.example']])['id'] ?? null);
        $query = $this->startForList('google', $id, 'kim@gmail.example');
        $this->client->request('DELETE', '/api/v1/mail-account-imports/'.$id, server: $this->user);
        self::assertResponseStatusCodeSame(204);

        $this->googleTokens();
        $page = $this->returnFromProvider('google', $query['state']);

        self::assertStringStartsWith(self::WEB.'/settings/accounts/import/'.$id.'?', $page);
        self::assertSame(1, $this->countRows('SELECT COUNT(*) FROM mail_account'));
    }

    public function testAnotherUserHandingInTheAnswerLeavesTheRowAlone(): void
    {
        $id = self::string($this->createList([['address' => 'kim@gmail.example']])['id'] ?? null);
        $query = $this->startForList('google', $id, 'kim@gmail.example');

        $answer = $this->providerRedirect('google', ['state' => $query['state'], 'code' => 'code-1']);
        $this->client->jsonRequest('POST', '/api/v1/provider-connections', $this->connectionInput($answer['query']), $this->userHeaders('lisa@example.test', ['settings:read', 'settings:write']));
        self::assertSame('different_user', $this->decodedResponse()['connectError'] ?? null);

        $entry = $this->entry($id, 'kim@gmail.example');
        self::assertSame(['todo', null], [$entry['state'] ?? null, $entry['failure'] ?? null]);
    }

    public function testAnAnswerHandedInTwiceDoesNotOverwriteHowTheFirstEnded(): void
    {
        $id = self::string($this->createList([['address' => 'kim@gmail.example']])['id'] ?? null);
        $query = $this->startForList('google', $id, 'kim@gmail.example');
        $answer = $this->providerRedirect('google', ['state' => $query['state'], 'code' => 'code-1']);
        $this->googleTokens();

        $this->client->jsonRequest('POST', '/api/v1/provider-connections', $this->connectionInput($answer['query']), $this->user);
        self::assertNull($this->decodedResponse()['connectError'] ?? null);
        $this->client->jsonRequest('POST', '/api/v1/provider-connections', $this->connectionInput($answer['query']), $this->user);
        self::assertSame('expired', $this->decodedResponse()['connectError'] ?? null);

        self::assertSame(['connected', null], [$this->entry($id, 'kim@gmail.example')['state'] ?? null, $this->entry($id, 'kim@gmail.example')['failure'] ?? null]);
    }

    public function testAnIdnAddressOfTheListSignsInByItsAsciiDomain(): void
    {
        $id = self::string($this->createList([['address' => 'kim@müller.de']])['id'] ?? null);

        $query = $this->startForList('google', $id, 'kim@müller.de');

        self::assertSame('kim@xn--mller-kva.de', $query['login_hint']);
    }

    public function testNothingIsSignedInLookedUpOrMarkedForAListAnAppMadeBeforeItIsConfirmed(): void
    {
        $app = $this->thirdPartyHeaders('kim@example.test', ['settings:read', 'settings:write']);
        $id = self::string($this->createList([['address' => 'kim@gmail.example'], ['address' => 'anna@partner.example']], $app)['id'] ?? null);
        $entry = $this->entryId($id, 'anna@partner.example');

        $this->client->jsonRequest('POST', '/api/v1/provider-authorizations', ['provider' => 'google', 'emailAddress' => 'kim@gmail.example', 'importId' => $id], $this->user);
        self::assertResponseStatusCodeSame(422);
        self::assertSame(['importId'], $this->violationPaths());
        self::assertSame(0, $this->countRows('SELECT COUNT(*) FROM provider_authorization_request'));

        $this->client->request('GET', '/api/v1/mail-server-settings?'.http_build_query(['emailAddress' => 'anna@partner.example', 'importId' => $id]), server: $this->user);
        self::assertResponseStatusCodeSame(422);
        self::assertSame(['importId'], $this->violationPaths());

        $this->markEntry($id, ['entryId' => $entry, 'state' => 'skipped']);
        self::assertResponseStatusCodeSame(422);
        self::assertSame(['entryId'], $this->violationPaths());

        $this->client->jsonRequest('POST', '/api/v1/mail-account-imports/'.$id.'/confirmation', [], $this->user);
        self::assertResponseIsSuccessful();

        $this->startForList('google', $id, 'kim@gmail.example');
        self::assertSame(1, $this->countRows('SELECT COUNT(*) FROM provider_authorization_request'));
        $this->markEntry($id, ['entryId' => $entry, 'state' => 'skipped']);
        self::assertResponseIsSuccessful();
    }

    public function testTheLookupOfAnAddressOfAListNeedsTheListToHoldIt(): void
    {
        $id = self::string($this->createList([['address' => 'anna@partner.example']])['id'] ?? null);
        $lisasList = self::string($this->createList([['address' => 'lisa@partner.example']], $this->userHeaders('lisa@example.test', ['settings:write']))['id'] ?? null);

        $this->client->request('GET', '/api/v1/mail-server-settings?'.http_build_query(['emailAddress' => 'other@partner.example', 'importId' => $id]), server: $this->user);
        self::assertResponseStatusCodeSame(422);
        $this->client->request('GET', '/api/v1/mail-server-settings?'.http_build_query(['emailAddress' => 'lisa@partner.example', 'importId' => $lisasList]), server: $this->user);
        self::assertResponseStatusCodeSame(422);
        $this->client->request('GET', '/api/v1/mail-server-settings?'.http_build_query(['emailAddress' => 'anna@partner.example', 'importId' => 'not-a-list']), server: $this->user);
        self::assertResponseStatusCodeSame(422);
    }

    public function testAnIdnAddressConnectsWhicheverWayTheProviderSpellsIt(): void
    {
        $id = self::string($this->createList([['address' => 'kim@müller.de'], ['address' => 'anna@xn--mller-kva.de']])['id'] ?? null);
        self::assertSame(['kim@xn--mller-kva.de', 'anna@xn--mller-kva.de'], array_column(self::asList($this->readList($id)['entries'] ?? null), 'address'));

        $query = $this->startForList('google', $id, 'kim@müller.de');
        $this->googleTokens(claims: ['email' => 'Kim@Müller.de', 'sub' => 'google-sub-3']);
        $page = $this->returnFromProvider('google', $query['state']);

        self::assertStringNotContainsString('wrong_account', $page);
        self::assertSame('connected', $this->entryState($id, 'kim@xn--mller-kva.de'), 'An account stored with its domain in Unicode is the row of its ASCII spelling.');

        $query = $this->startForList('google', $id, 'anna@xn--mller-kva.de');
        $this->googleTokens(claims: ['email' => 'anna@xn--mller-kva.de', 'sub' => 'google-sub-4']);
        $this->returnFromProvider('google', $query['state']);
        self::assertSame('connected', $this->entryState($id, 'anna@xn--mller-kva.de'));
    }

    public function testAConnectedElsewhereFailureIsAlreadyConnectedWhileTheAccountExistsAndToDoAfter(): void
    {
        $id = self::string($this->createList([['address' => 'kim@gmail.example']])['id'] ?? null);
        $query = $this->startForList('google', $id, 'kim@gmail.example');
        // The address was connected with a password meanwhile: the Google sign-in for it is refused.
        $account = $this->createImapAccount('kim@gmail.example');
        $this->googleTokens();
        self::assertStringContainsString('connectError=already_connected', $this->returnFromProvider('google', $query['state']));

        self::assertSame(['already_connected', null], [$this->entry($id, 'kim@gmail.example')['state'] ?? null, $this->entry($id, 'kim@gmail.example')['failure'] ?? null]);

        $this->client->request('DELETE', '/api/v1/mail-accounts/'.$account, server: $this->user);
        self::assertResponseStatusCodeSame(204);
        self::assertSame(['todo', null], [$this->entry($id, 'kim@gmail.example')['state'] ?? null, $this->entry($id, 'kim@gmail.example')['failure'] ?? null]);
    }

    /**
     * @param list<array<string, string>> $entries
     * @param array<string, string>|null  $headers
     *
     * @return array<mixed>
     */
    private function createList(array $entries, ?array $headers = null): array
    {
        $this->client->jsonRequest('POST', '/api/v1/mail-account-imports', ['entries' => $entries], $headers ?? $this->user);

        return $this->decodedResponse();
    }

    /**
     * @return array<mixed>
     */
    private function readList(string $id): array
    {
        $this->client->request('GET', '/api/v1/mail-account-imports/'.$id, server: $this->user);
        self::assertResponseIsSuccessful();

        return $this->decodedResponse();
    }

    /**
     * @return array<mixed>
     */
    private function entry(string $id, string $address): array
    {
        foreach (self::asList($this->readList($id)['entries'] ?? null) as $entry) {
            if (($entry['address'] ?? null) === $address) {
                return $entry;
            }
        }
        self::fail(\sprintf('The list has no entry %s.', $address));
    }

    private function entryId(string $id, string $address): string
    {
        return self::string($this->entry($id, $address)['id'] ?? null);
    }

    private function entryState(string $id, string $address): string
    {
        return self::string($this->entry($id, $address)['state'] ?? null);
    }

    /**
     * @param array<string, string> $body
     */
    private function markEntry(string $id, array $body): void
    {
        $this->client->jsonRequest('POST', '/api/v1/mail-account-imports/'.$id.'/entry-states', $body, $this->user);
    }

    /**
     * @return array<string, string>
     */
    private function startForList(string $provider, string $id, string $address): array
    {
        $this->client->jsonRequest('POST', '/api/v1/provider-authorizations', ['provider' => $provider, 'emailAddress' => $address, 'importId' => $id], $this->user);
        self::assertResponseStatusCodeSame(201);
        parse_str((string) parse_url($this->responseString('authorizationUrl'), \PHP_URL_QUERY), $query);

        /** @var array<string, string> $query */
        return $query;
    }

    private function createImapAccount(string $address): string
    {
        $this->client->jsonRequest('POST', '/api/v1/mail-accounts', [
            'emailAddress' => $address,
            'displayName' => $address,
            'username' => $address,
            'password' => 'app-password-1',
            'imap' => ['host' => 'imap.company.example', 'port' => 993, 'security' => 'tls'],
            'smtp' => ['host' => 'smtp.company.example', 'port' => 465, 'security' => 'tls'],
        ], $this->user);
        self::assertResponseStatusCodeSame(201);

        return $this->responseString('id');
    }

    /**
     * @return list<array<string, string>>
     */
    private static function addresses(int $count): array
    {
        return array_map(static fn (int $i): array => ['address' => "person{$i}@partner.example"], range(1, $count));
    }

    /**
     * @param array<mixed> $list
     *
     * @return list<array{address: mixed, provider: mixed, state: mixed}>
     */
    private static function entrySummaries(array $list): array
    {
        return array_map(static fn (array $entry): array => ['address' => $entry['address'] ?? null, 'provider' => $entry['provider'] ?? null, 'state' => $entry['state'] ?? null], self::asList($list['entries'] ?? null));
    }

    /**
     * @return list<array<mixed>>
     */
    private static function asList(mixed $value): array
    {
        self::assertIsArray($value);
        self::assertTrue(array_is_list($value));
        $list = [];
        foreach ($value as $item) {
            self::assertIsArray($item);
            $list[] = $item;
        }

        return $list;
    }

    private static function string(mixed $value): string
    {
        self::assertIsString($value);

        return $value;
    }
}
