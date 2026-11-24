<?php

declare(strict_types=1);

namespace App\Tests\Functional\Mcp;

use App\Tests\Functional\AuthenticatesUsers;
use App\Tests\Functional\ConnectsThirdPartyApps;
use App\Tests\Functional\DatabaseTestCase;

/**
 * Adding mail accounts through an assistant: it makes a list and hands the user a link; the user signs in on Tresso's
 * page. The assistant never signs in, and no tool takes or answers a secret.
 */
final class McpMailAccountImportToolsTest extends DatabaseTestCase
{
    use AuthenticatesUsers;
    use ConnectsThirdPartyApps;
    use TalksMcp;

    private const string WEB = 'http://localhost:5173';

    /** @var array<string, string> */
    private array $headers;

    private string $session;

    protected function setUp(): void
    {
        parent::setUp();
        $this->bootstrapOAuthClients();
        $this->createUser('kim@example.test', 'Kim Visser');
        $this->createUser('lisa@example.test', 'Lisa Bakker');
        $this->headers = $this->thirdPartyHeaders('kim@example.test', ['settings:read', 'settings:write']);
        $this->session = $this->mcpInitialize($this->headers);
    }

    public function testAnAppWithSettingsWriteMakesAListAndGetsTheLinkForTheUser(): void
    {
        $this->createImapAccount('kim@company.example');

        $answer = $this->mcpCallOk($this->headers, $this->session, 'add_mail_accounts', ['entries' => [
            ['address' => 'kim@gmail.example', 'provider' => 'google'],
            ['address' => 'kim@company.example'],
            ['address' => 'Kim@Gmail.example'],
            ['address' => 'kim@outlook.example', 'provider' => 'microsoft'],
        ]]);

        $id = self::asString($answer['importId'] ?? null);
        self::assertSame(self::WEB.'/settings/accounts/import/'.$id, $answer['link'] ?? null);
        self::assertSame(2, $answer['taken'] ?? null);
        self::assertSame(['kim@gmail.example', 'kim@outlook.example'], array_column(self::asList($answer['entries'] ?? null), 'address'));
        self::assertSame([
            ['address' => 'kim@company.example', 'reason' => 'already_connected', 'message' => 'This address is connected already.'],
            ['address' => 'kim@gmail.example', 'reason' => 'duplicate', 'message' => 'This address is in the list already.'],
        ], $answer['leftOut'] ?? null);
        $instruction = self::asString($answer['instruction'] ?? null);
        self::assertStringContainsString(self::asString($answer['link']), $instruction);
        self::assertStringContainsString('cannot sign in', $instruction);
        self::assertStringContainsString('Never ask the user for a password', $instruction);
        self::assertSame('Some app', $this->connection()->fetchOne('SELECT created_by FROM mail_account_import WHERE id = ?', [$id]));
        self::assertSame(0, $this->countRows('SELECT COUNT(*) FROM provider_authorization_request'), 'Making a list starts no sign-in.');

        $progress = $this->mcpCallOk($this->headers, $this->session, 'get_mail_account_import', ['id' => $id]);
        self::assertSame(['todo' => 2, 'connected' => 0, 'already_connected' => 0, 'failed' => 0, 'skipped' => 0], $progress['progress'] ?? null);
        self::assertSame(['todo', 'todo'], array_column(self::asList($progress['entries'] ?? null), 'state'));
        self::assertSame(self::asString($answer['link']), $progress['link'] ?? null);
    }

    public function testTheToolsSayPlainlyThatTheAssistantCannotSignIn(): void
    {
        $tools = [];
        foreach ($this->mcpTools($this->headers, $this->session) as $tool) {
            $tools[self::asString($tool['name'] ?? null)] = $tool;
        }

        foreach (['add_mail_accounts', 'get_mail_account_import', 'reconnect_mail_account'] as $name) {
            self::assertArrayHasKey($name, $tools);
            self::assertMatchesRegularExpression('/cannot sign in|only the user can/i', self::asString($tools[$name]['description'] ?? null), $name);
        }
        self::assertStringContainsString('Needs the scope settings:write.', self::asString($tools['add_mail_accounts']['description'] ?? null));
        self::assertStringContainsString('Needs the scope settings:read.', self::asString($tools['get_mail_account_import']['description'] ?? null));
        self::assertStringContainsString('Needs the scope settings:read.', self::asString($tools['reconnect_mail_account']['description'] ?? null));
        self::assertTrue(self::asArray($tools['reconnect_mail_account']['annotations'] ?? null)['readOnlyHint'] ?? null, 'It changes nothing.');
        self::assertFalse(self::asArray($tools['add_mail_accounts']['annotations'] ?? null)['destructiveHint'] ?? null);

        $entry = self::asArray(self::asArray(self::asArray(self::asArray($tools['add_mail_accounts']['inputSchema'] ?? null)['properties'] ?? null)['entries'] ?? null)['items'] ?? null);
        self::assertSame(['address', 'provider'], array_keys(self::asArray($entry['properties'] ?? null)), 'An entry has no field for a secret.');
        self::assertFalse($entry['additionalProperties'] ?? true);
    }

    public function testASecretInTheArgumentsIsRefusedBeforeAnythingRuns(): void
    {
        $message = $this->mcpRequest($this->headers, $this->session, 'tools/call', ['name' => 'add_mail_accounts', 'arguments' => [
            'entries' => [['address' => 'kim@gmail.example', 'password' => 'hunter2']],
        ]]);

        self::assertSame(-32602, self::asArray($message['error'] ?? null)['code'] ?? null);
        self::assertSame(0, $this->countRows('SELECT COUNT(*) FROM mail_account_import'));
    }

    public function testFiftyAddressesAtMost(): void
    {
        $entries = array_map(static fn (int $i): array => ['address' => "person{$i}@partner.example"], range(1, 51));
        $message = $this->mcpRequest($this->headers, $this->session, 'tools/call', ['name' => 'add_mail_accounts', 'arguments' => ['entries' => $entries]]);
        self::assertSame(-32602, self::asArray($message['error'] ?? null)['code'] ?? null);

        $answer = $this->mcpCallOk($this->headers, $this->session, 'add_mail_accounts', ['entries' => \array_slice($entries, 0, 50)]);
        self::assertSame(50, $answer['taken'] ?? null);
    }

    public function testAListWithNothingToAddIsAToolErrorPerAddress(): void
    {
        $this->createImapAccount('kim@company.example');

        $error = $this->mcpCallError($this->headers, $this->session, 'add_mail_accounts', ['entries' => [['address' => 'kim@company.example'], ['address' => 'not-an-address']]]);

        self::assertStringContainsString('entries[0].address: This address is connected already.', $error);
        self::assertStringContainsString('entries[1].address: This is not an email address.', $error);
    }

    public function testTheAppCannotStartASignInOrAddAnAccountItself(): void
    {
        $id = self::asString($this->mcpCallOk($this->headers, $this->session, 'add_mail_accounts', ['entries' => [['address' => 'kim@gmail.example']]])['importId'] ?? null);
        $toolNames = $this->mcpToolNames($this->headers, $this->session);
        foreach ($toolNames as $name) {
            self::assertDoesNotMatchRegularExpression('/sign_in|authoriz|^connect_|create_mail_account|password/', $name);
        }

        // Its token is refused where a sign-in starts, even for an address of its own list.
        $this->client->jsonRequest('POST', '/api/v1/provider-authorizations', ['provider' => 'google', 'emailAddress' => 'kim@gmail.example', 'importId' => $id], $this->headers);
        self::assertResponseStatusCodeSame(403);
        self::assertSame(0, $this->countRows('SELECT COUNT(*) FROM provider_authorization_request'));
    }

    public function testResultsHoldNoSecret(): void
    {
        $account = $this->createImapAccount('kim@company.example', 'the-imap-password');
        $this->connection()->executeStatement("UPDATE mail_account SET status = 'auth_failed', status_detail = 'Login refused' WHERE id = ?", [$account]);
        $id = self::asString($this->mcpCallOk($this->headers, $this->session, 'add_mail_accounts', ['entries' => [['address' => 'kim@gmail.example']]])['importId'] ?? null);

        $texts = [];
        foreach ([
            ['get_mail_account_import', ['id' => $id]],
            ['reconnect_mail_account', ['id' => $account]],
            ['list_mail_accounts', []],
        ] as [$tool, $arguments]) {
            $texts[] = $this->mcpText($this->mcpCall($this->headers, $this->session, $tool, $arguments));
        }
        $all = implode("\n", $texts);
        self::assertStringNotContainsString('the-imap-password', $all);
        self::assertStringNotContainsString('f1.', $all, 'No sealed value leaves the API.');
        self::assertStringNotContainsString('imap.company.example', $all, 'Nor how an account connects.');
    }

    public function testReconnectGivesTheLinkForAnAccountWhoseSignInFailedAndChangesNothing(): void
    {
        $account = $this->createImapAccount('kim@company.example');

        $fine = $this->mcpCallOk($this->headers, $this->session, 'reconnect_mail_account', ['id' => $account]);
        self::assertFalse($fine['signInNeeded'] ?? null);
        self::assertArrayNotHasKey('link', $fine);

        $this->connection()->executeStatement("UPDATE mail_account SET status = 'auth_failed' WHERE id = ?", [$account]);
        $before = $this->connection()->fetchAssociative('SELECT * FROM mail_account WHERE id = ?', [$account]);

        $answer = $this->mcpCallOk($this->headers, $this->session, 'reconnect_mail_account', ['id' => $account]);

        self::assertTrue($answer['signInNeeded'] ?? null);
        self::assertSame(self::WEB.'/settings/accounts#account-'.$account, $answer['link'] ?? null);
        self::assertStringContainsString('cannot sign in', self::asString($answer['instruction'] ?? null));
        self::assertSame($before, $this->connection()->fetchAssociative('SELECT * FROM mail_account WHERE id = ?', [$account]));
        self::assertSame(0, $this->countRows('SELECT COUNT(*) FROM provider_authorization_request'));
    }

    public function testAnotherUsersListAndAccountAreOutOfReach(): void
    {
        $account = $this->createImapAccount('kim@company.example');
        $id = self::asString($this->mcpCallOk($this->headers, $this->session, 'add_mail_accounts', ['entries' => [['address' => 'kim@gmail.example']]])['importId'] ?? null);

        $lisa = $this->thirdPartyHeaders('lisa@example.test', ['settings:read', 'settings:write']);
        $session = $this->mcpInitialize($lisa);

        self::assertStringStartsWith('Not found', $this->mcpCallError($lisa, $session, 'get_mail_account_import', ['id' => $id]));
        self::assertStringStartsWith('Not found', $this->mcpCallError($lisa, $session, 'reconnect_mail_account', ['id' => $account]));
    }

    public function testReadingNeedsSettingsReadAndMakingSettingsWrite(): void
    {
        $readOnly = $this->personalAccessTokenHeaders('kim@example.test', ['settings:read']);
        $session = $this->mcpInitialize($readOnly);

        $names = $this->mcpToolNames($readOnly, $session);
        self::assertContains('get_mail_account_import', $names);
        self::assertContains('reconnect_mail_account', $names);
        self::assertNotContains('add_mail_accounts', $names);
        self::assertStringContainsString('settings:write', $this->mcpCallError($readOnly, $session, 'add_mail_accounts', ['entries' => [['address' => 'kim@gmail.example']]]));
        self::assertSame(0, $this->countRows('SELECT COUNT(*) FROM mail_account_import'));
    }

    private function createImapAccount(string $address, string $password = 'app-password-1'): string
    {
        $this->client->jsonRequest('POST', '/api/v1/mail-accounts', [
            'emailAddress' => $address,
            'displayName' => $address,
            'username' => $address,
            'password' => $password,
            'imap' => ['host' => 'imap.company.example', 'port' => 993, 'security' => 'tls'],
            'smtp' => ['host' => 'smtp.company.example', 'port' => 465, 'security' => 'tls'],
        ], $this->userHeaders('kim@example.test', ['settings:write']));
        self::assertResponseStatusCodeSame(201);

        return $this->responseString('id');
    }
}
