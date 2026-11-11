<?php

declare(strict_types=1);

namespace App\Tests\Functional;

use App\Entity\MailAccount;
use App\Security\Crypto\CredentialVault;
use Doctrine\ORM\EntityManagerInterface;
use PHPUnit\Framework\Attributes\DataProvider;
use Symfony\Component\Uid\Uuid;

/**
 * What only our own apps may do, even with settings:write: add or remove mail accounts, change how one connects
 * (servers, username, password, calendar server), sign in with a mail provider, register a device for notifications,
 * and billing. An app that is not ours or a personal access token could otherwise send the user's mail password to a
 * server of its own, keep getting notifications after it is disconnected, or start payments. Plain settings stay open.
 */
final class FirstPartyOnlySettingsTest extends DatabaseTestCase
{
    use AuthenticatesUsers;
    use ConnectsThirdPartyApps;

    private const array SETTINGS = ['settings:read', 'settings:write'];

    private string $accountId;

    protected function setUp(): void
    {
        parent::setUp();
        $this->bootstrapOAuthClients();
        $this->createUser('kim@example.test', 'Kim Visser');
        $this->client->jsonRequest('POST', '/api/v1/mail-accounts', self::imapAccount(), $this->web());
        self::assertResponseStatusCodeSame(201, 'Our own apps add mail accounts.');
        $this->accountId = $this->responseString('id');
    }

    /**
     * @return iterable<string, array{string}>
     */
    public static function callers(): iterable
    {
        yield 'an app that is not ours' => ['third-party'];
        yield 'a personal access token' => ['personal access token'];
    }

    #[DataProvider('callers')]
    public function testOnlyOurOwnAppsAddOrRemoveMailAccounts(string $caller): void
    {
        $headers = $this->caller($caller);

        $this->client->jsonRequest('POST', '/api/v1/mail-accounts', ['emailAddress' => 'kim@other.example'] + self::imapAccount(), $headers);
        self::assertResponseStatusCodeSame(403);
        $this->client->request('GET', '/api/v1/mail-server-settings?emailAddress=kim%40other.example', server: $headers);
        self::assertResponseStatusCodeSame(403);
        $this->client->jsonRequest('POST', '/api/v1/mail-account-checks', array_diff_key(['emailAddress' => 'kim@other.example'] + self::imapAccount(), ['displayName' => true]), $headers);
        self::assertResponseStatusCodeSame(403, 'A check signs in with a password the caller names, at a server the caller names.');
        $this->client->request('DELETE', '/api/v1/mail-accounts/'.$this->accountId, server: $headers);
        self::assertResponseStatusCodeSame(403);

        self::assertSame(1, $this->countRows('SELECT COUNT(*) FROM mail_account'));
        $this->client->request('GET', '/api/v1/mail-accounts', server: $headers);
        self::assertResponseIsSuccessful('Reading them is fine.');
    }

    /**
     * @return iterable<string, array{string, array<string, mixed>}>
     */
    public static function connectionChanges(): iterable
    {
        foreach (self::callers() as $caller => [$kind]) {
            yield $caller.': IMAP server' => [$kind, ['imap' => ['host' => 'imap.attacker.example', 'port' => 993, 'security' => 'tls']]];
            yield $caller.': SMTP server' => [$kind, ['smtp' => ['host' => 'smtp.company.example', 'port' => 587, 'security' => 'starttls']]];
            yield $caller.': username' => [$kind, ['username' => 'someone-else']];
            yield $caller.': password' => [$kind, ['password' => 'new-password']];
            yield $caller.': calendar server' => [$kind, ['calendarUrl' => 'https://dav.attacker.example/']];
        }
    }

    /**
     * @param array<string, mixed> $change
     */
    #[DataProvider('connectionChanges')]
    public function testOnlyOurOwnAppsChangeHowAMailAccountConnects(string $caller, array $change): void
    {
        $this->patch($change, $this->caller($caller));

        self::assertResponseStatusCodeSame(403);
        $account = $this->account();
        self::assertSame('imap.company.example', $account->getImap()?->host);
        self::assertSame(465, $account->getSmtp()?->port);
        self::assertSame('kim@company.example', $account->getUsername());
        self::assertNull($account->getCalendarServer());
        self::assertSame('app-password-1', $this->password());
    }

    #[DataProvider('callers')]
    public function testPlainSettingsOfAMailAccountStayOpen(string $caller): void
    {
        $this->patch(['displayName' => 'Work mail', 'status' => 'paused'], $this->caller($caller));

        self::assertResponseIsSuccessful();
        self::assertSame('Work mail', $this->responseString('displayName'));
        self::assertSame('paused', $this->responseString('status'));
    }

    #[DataProvider('callers')]
    public function testOnlyOurOwnAppsRegisterNotificationDevicesOrSignInWithAProvider(string $caller): void
    {
        $headers = $this->caller($caller);

        $this->client->jsonRequest('POST', '/api/v1/notification-devices', ['kind' => 'webpush', 'endpoint' => 'https://push.attacker.example/kim', 'publicKey' => 'x', 'authSecret' => 'y', 'name' => 'Spy'], $headers);
        self::assertResponseStatusCodeSame(403);
        $this->client->jsonRequest('POST', '/api/v1/provider-authorizations', ['provider' => 'google'], $headers);
        self::assertResponseStatusCodeSame(403);
        $this->client->jsonRequest('POST', '/api/v1/provider-connections', ['provider' => 'google', 'state' => 'a-state', 'code' => 'a-code'], $headers);
        self::assertResponseStatusCodeSame(403);

        self::assertSame(0, $this->countRows('SELECT COUNT(*) FROM notification_device'));
        $this->client->request('GET', '/api/v1/notification-devices', server: $headers);
        self::assertResponseIsSuccessful('Reading them is fine.');
    }

    #[DataProvider('callers')]
    public function testOnlyOurOwnAppsSeeOrChangeBilling(string $caller): void
    {
        $headers = $this->caller($caller);
        $organizationId = $this->connection()->fetchOne('SELECT id FROM organization');

        $this->client->request('GET', '/api/v1/billing', server: $headers);
        self::assertResponseStatusCodeSame(403);
        $this->client->jsonRequest('POST', '/api/v1/billing/checkout', ['organizationId' => $organizationId, 'plan' => 'monthly'], $headers);
        self::assertResponseStatusCodeSame(403);
        $this->client->jsonRequest('POST', '/api/v1/billing/portal', ['organizationId' => $organizationId], $headers);
        self::assertResponseStatusCodeSame(403);
    }

    public function testOurOwnAppsStillDoAllOfIt(): void
    {
        $web = $this->web();

        $this->patch([
            'imap' => ['host' => 'imap.new.example', 'port' => 993, 'security' => 'tls'],
            'password' => 'password-for-the-new-server',
        ], $web + ['CONTENT_TYPE' => 'application/merge-patch+json']);
        self::assertResponseIsSuccessful();
        self::assertSame('imap.new.example', $this->account()->getImap()?->host);
        self::assertSame('password-for-the-new-server', $this->password());

        $this->client->jsonRequest('POST', '/api/v1/notification-devices', ['kind' => 'expo', 'endpoint' => 'ExponentPushToken[kim-phone]', 'name' => 'Kim\'s phone'], $web);
        self::assertResponseIsSuccessful();
        $this->client->request('GET', '/api/v1/billing', server: $web);
        self::assertResponseIsSuccessful();
        $this->client->request('DELETE', '/api/v1/mail-accounts/'.$this->accountId, server: $web);
        self::assertResponseStatusCodeSame(204);
    }

    /**
     * @return iterable<string, array{array<string, mixed>, string}>
     */
    public static function newServersWithoutPassword(): iterable
    {
        yield 'a new IMAP host' => [['imap' => ['host' => 'imap.new.example', 'port' => 993, 'security' => 'tls']], 'IMAP server'];
        yield 'a new SMTP host' => [['smtp' => ['host' => 'smtp.new.example', 'port' => 465, 'security' => 'tls']], 'SMTP server'];
        yield 'a new username' => [['username' => 'kim.visser@company.example'], 'username'];
        yield 'a calendar server on a new host' => [['calendarUrl' => 'https://dav.new.example/kim/'], 'calendar server'];
    }

    /**
     * @param array<string, mixed> $change
     */
    #[DataProvider('newServersWithoutPassword')]
    public function testTheSavedPasswordIsNeverSentToANewServer(array $change, string $named): void
    {
        $this->patch($change, $this->web());

        self::assertResponseStatusCodeSame(422);
        $violations = $this->decodedResponse()['violations'] ?? null;
        self::assertIsArray($violations);
        self::assertIsArray($violations[0] ?? null);
        self::assertSame('password', $violations[0]['propertyPath'] ?? null);
        self::assertIsString($violations[0]['message'] ?? null);
        self::assertStringContainsString($named, $violations[0]['message']);
        self::assertSame('imap.company.example', $this->account()->getImap()?->host);
        self::assertSame('kim@company.example', $this->account()->getUsername());
    }

    public function testThePortOrSecurityOnTheSameHostNeedsNoPassword(): void
    {
        $this->patch([
            'smtp' => ['host' => 'SMTP.company.example', 'port' => 587, 'security' => 'starttls'],
            'username' => 'kim@company.example',
        ], $this->web());

        self::assertResponseIsSuccessful();
        self::assertSame(587, $this->account()->getSmtp()?->port);
        self::assertSame('app-password-1', $this->password());
    }

    /**
     * @param array<string, mixed>  $change
     * @param array<string, string> $headers
     */
    private function patch(array $change, array $headers): void
    {
        $this->client->request('PATCH', '/api/v1/mail-accounts/'.$this->accountId, server: $headers + ['CONTENT_TYPE' => 'application/merge-patch+json'], content: json_encode($change, \JSON_THROW_ON_ERROR));
    }

    /** @return array<string, string> */
    private function web(): array
    {
        return $this->userHeaders('kim@example.test', self::SETTINGS);
    }

    /** @return array<string, string> */
    private function caller(string $kind): array
    {
        return 'third-party' === $kind
            ? $this->thirdPartyHeaders('kim@example.test', self::SETTINGS)
            : $this->personalAccessTokenHeaders('kim@example.test', self::SETTINGS);
    }

    private function account(): MailAccount
    {
        $entityManager = static::getContainer()->get(EntityManagerInterface::class);
        $entityManager->clear();
        $account = $entityManager->find(MailAccount::class, Uuid::fromString($this->accountId));
        self::assertInstanceOf(MailAccount::class, $account);

        return $account;
    }

    private function password(): mixed
    {
        return static::getContainer()->get(CredentialVault::class)->open($this->account())['password'] ?? null;
    }

    /** @return array<string, mixed> */
    private static function imapAccount(): array
    {
        return [
            'emailAddress' => 'kim@company.example',
            'displayName' => 'Work',
            'username' => 'kim@company.example',
            'password' => 'app-password-1',
            'imap' => ['host' => 'imap.company.example', 'port' => 993, 'security' => 'tls'],
            'smtp' => ['host' => 'smtp.company.example', 'port' => 465, 'security' => 'tls'],
        ];
    }
}
