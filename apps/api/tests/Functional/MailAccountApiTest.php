<?php

declare(strict_types=1);

namespace App\Tests\Functional;

use App\Entity\MailAccount;
use App\Enum\MailAccountStatus;
use App\Security\Crypto\CredentialVault;
use Doctrine\ORM\EntityManagerInterface;
use Symfony\Component\Uid\Uuid;

final class MailAccountApiTest extends DatabaseTestCase
{
    use AuthenticatesUsers;

    private const array READ_WRITE = ['settings:read', 'settings:write'];

    protected function setUp(): void
    {
        parent::setUp();
        $this->bootstrapOAuthClients();
        $this->createUser('kim@example.test', 'Kim Visser');
        $this->createUser('lisa@example.test', 'Lisa Bakker');
    }

    public function testCreateReturnsAccountWithoutPassword(): void
    {
        $headers = $this->userHeaders('kim@example.test', self::READ_WRITE);

        $this->client->jsonRequest('POST', '/api/v1/mail-accounts', $this->imapPayload(), $headers);

        self::assertResponseStatusCodeSame(201);
        $body = $this->decodedResponse();
        self::assertSame('kim@company.example', $body['emailAddress'] ?? null);
        self::assertSame('imap', $body['provider'] ?? null);
        self::assertSame('active', $body['status'] ?? null);
        self::assertSame(['host' => 'imap.company.example', 'port' => 993, 'security' => 'tls'], $body['imap'] ?? null);
        self::assertStringNotContainsString('app-password-1', (string) $this->client->getResponse()->getContent());
        self::assertArrayNotHasKey('password', $body);
    }

    public function testUnknownValuesAreExplicitNulls(): void
    {
        $headers = $this->userHeaders('kim@example.test', self::READ_WRITE);
        $this->client->jsonRequest('POST', '/api/v1/mail-accounts', $this->imapPayload(), $headers);
        $id = $this->responseString('id');

        $this->client->request('GET', '/api/v1/mail-accounts/'.$id, server: $headers);

        $body = $this->decodedResponse();
        self::assertArrayHasKey('statusDetail', $body);
        self::assertNull($body['statusDetail']);
        self::assertArrayHasKey('lastSyncedAt', $body);
        self::assertNull($body['lastSyncedAt']);
    }

    public function testPasswordIsStoredEncryptedAndDecryptable(): void
    {
        $headers = $this->userHeaders('kim@example.test', self::READ_WRITE);
        $this->client->jsonRequest('POST', '/api/v1/mail-accounts', $this->imapPayload(), $headers);
        $account = $this->account($this->responseString('id'));

        $stored = (string) $account->getEncryptedCredentials();
        self::assertStringStartsWith('f1.1.', $stored);
        self::assertStringNotContainsString('app-password-1', $stored);
        self::assertStringNotContainsString('app-password-1', (string) base64_decode(substr($stored, 5), true));
        self::assertSame(['type' => 'password', 'password' => 'app-password-1'], static::getContainer()->get(CredentialVault::class)->open($account));
    }

    public function testUsersOnlySeeTheirOwnAccounts(): void
    {
        $kim = $this->userHeaders('kim@example.test', self::READ_WRITE);
        $this->client->jsonRequest('POST', '/api/v1/mail-accounts', $this->imapPayload(), $kim);
        $kimsAccountId = $this->responseString('id');

        $lisa = $this->userHeaders('lisa@example.test', self::READ_WRITE);
        $this->client->request('GET', '/api/v1/mail-accounts', server: $lisa);
        self::assertResponseIsSuccessful();
        self::assertSame([], $this->decodedResponse());

        $this->client->request('GET', '/api/v1/mail-accounts/'.$kimsAccountId, server: $lisa);
        self::assertResponseStatusCodeSame(404);

        $this->client->request('PATCH', '/api/v1/mail-accounts/'.$kimsAccountId, server: $lisa + ['CONTENT_TYPE' => 'application/merge-patch+json'], content: '{"displayName":"Taken"}');
        self::assertResponseStatusCodeSame(404);

        $this->client->request('DELETE', '/api/v1/mail-accounts/'.$kimsAccountId, server: $lisa);
        self::assertResponseStatusCodeSame(404);

        $this->client->request('GET', '/api/v1/mail-accounts', server: $kim);
        self::assertCount(1, $this->decodedResponse());
    }

    public function testDuplicateEmailIsRejected(): void
    {
        $headers = $this->userHeaders('kim@example.test', self::READ_WRITE);
        $this->client->jsonRequest('POST', '/api/v1/mail-accounts', $this->imapPayload(), $headers);
        self::assertResponseStatusCodeSame(201);

        $this->client->jsonRequest('POST', '/api/v1/mail-accounts', ['emailAddress' => 'KIM@company.example'] + $this->imapPayload(), $headers);

        self::assertResponseStatusCodeSame(422);
        self::assertStringContainsString('emailAddress', (string) $this->client->getResponse()->getContent());
    }

    /**
     * @return iterable<string, array{array<string, mixed>, string}>
     */
    public static function invalidPayloads(): iterable
    {
        yield 'invalid email' => [['emailAddress' => 'not-an-email'], 'emailAddress'];
        yield 'missing password' => [['password' => ''], 'password'];
        yield 'missing imap' => [['imap' => null], 'imap'];
        yield 'port out of range' => [['imap' => ['host' => 'imap.company.example', 'port' => 70000, 'security' => 'tls']], 'imap.port'];
        yield 'invalid host' => [['smtp' => ['host' => 'not a host', 'port' => 465, 'security' => 'tls']], 'smtp.host'];
    }

    /**
     * @param array<string, mixed> $override
     */
    #[\PHPUnit\Framework\Attributes\DataProvider('invalidPayloads')]
    public function testInvalidInputIsRejected(array $override, string $path): void
    {
        $headers = $this->userHeaders('kim@example.test', self::READ_WRITE);

        $this->client->jsonRequest('POST', '/api/v1/mail-accounts', $override + $this->imapPayload(), $headers);

        self::assertResponseStatusCodeSame(422);
        self::assertStringContainsString('"propertyPath":"'.$path.'"', (string) $this->client->getResponse()->getContent());
    }

    public function testUpdateChangesSettingsAndNewPasswordClearsAuthFailure(): void
    {
        $headers = $this->userHeaders('kim@example.test', self::READ_WRITE);
        $this->client->jsonRequest('POST', '/api/v1/mail-accounts', $this->imapPayload(), $headers);
        $id = $this->responseString('id');

        $entityManager = static::getContainer()->get(EntityManagerInterface::class);
        $entityManager->wrapInTransaction(fn () => $this->account($id)->setStatus(MailAccountStatus::AuthFailed));

        $this->client->request('PATCH', '/api/v1/mail-accounts/'.$id, server: $headers + ['CONTENT_TYPE' => 'application/merge-patch+json'], content: json_encode([
            'displayName' => 'Work mail',
            'password' => 'app-password-2',
            'smtp' => ['host' => 'smtp.company.example', 'port' => 587, 'security' => 'starttls'],
        ], \JSON_THROW_ON_ERROR));

        self::assertResponseIsSuccessful();
        $body = $this->decodedResponse();
        self::assertSame('Work mail', $body['displayName'] ?? null);
        self::assertSame('active', $body['status'] ?? null);
        self::assertSame(['host' => 'smtp.company.example', 'port' => 587, 'security' => 'starttls'], $body['smtp'] ?? null);
        self::assertSame(['host' => 'imap.company.example', 'port' => 993, 'security' => 'tls'], $body['imap'] ?? null, 'Omitted settings stay unchanged.');

        $entityManager->clear();
        self::assertSame('app-password-2', static::getContainer()->get(CredentialVault::class)->open($this->account($id))['password']);
    }

    public function testNewServerSettingsEndTheLeaseSoTheWorkerStartsAFreshSession(): void
    {
        $headers = $this->userHeaders('kim@example.test', self::READ_WRITE);
        $this->client->jsonRequest('POST', '/api/v1/mail-accounts', $this->imapPayload(), $headers);
        $id = $this->responseString('id');
        $worker = $this->workerHeaders('sync:lease');
        self::assertSame([$id], $this->lease('w1', $worker));

        $entityManager = static::getContainer()->get(EntityManagerInterface::class);
        $entityManager->wrapInTransaction(fn () => $this->account($id)->setStatus(MailAccountStatus::Error, 'Could not connect to the mail server.'));

        $this->client->request('PATCH', '/api/v1/mail-accounts/'.$id, server: $headers + ['CONTENT_TYPE' => 'application/merge-patch+json'], content: json_encode([
            'password' => 'app-password-2',
            'imap' => ['host' => 'imap2.company.example', 'port' => 993, 'security' => 'tls'],
        ], \JSON_THROW_ON_ERROR));

        self::assertResponseIsSuccessful();
        $body = $this->decodedResponse();
        self::assertSame('active', $body['status'] ?? null);
        self::assertArrayHasKey('statusDetail', $body);
        self::assertNull($body['statusDetail']);

        $entityManager->clear();
        $account = $this->account($id);
        self::assertNull($account->getLeasedBy(), 'The lease of the worker that held the account has ended.');
        self::assertGreaterThan(new \DateTimeImmutable('now', new \DateTimeZone('UTC')), $account->getLeaseExpiresAt());

        self::assertSame([], $this->lease('w1', $worker), 'The holder no longer gets it back, so it stops its syncer.');
        self::assertSame([], $this->lease('w2', $worker), 'Nobody takes it while the old syncer stops.');

        $this->connection()->executeStatement('UPDATE mail_account SET lease_expires_at = :past', ['past' => new \DateTimeImmutable('-1 second', new \DateTimeZone('UTC'))->format('Y-m-d H:i:s')]);
        self::assertSame([$id], $this->lease('w1', $worker), 'Once the hold ends a fresh session starts.');
    }

    public function testANewPasswordForAnAccountNoWorkerHoldsIsTriedAtTheNextHeartbeat(): void
    {
        $headers = $this->userHeaders('kim@example.test', self::READ_WRITE);
        $this->client->jsonRequest('POST', '/api/v1/mail-accounts', $this->imapPayload(), $headers);
        $id = $this->responseString('id');
        static::getContainer()->get(EntityManagerInterface::class)->wrapInTransaction(fn () => $this->account($id)->setStatus(MailAccountStatus::AuthFailed, 'The mail server rejected the username or password.'));

        $this->client->request('PATCH', '/api/v1/mail-accounts/'.$id, server: $headers + ['CONTENT_TYPE' => 'application/merge-patch+json'], content: '{"password":"app-password-2"}');
        self::assertResponseIsSuccessful();

        self::assertSame([$id], $this->lease('w1', $this->workerHeaders('sync:lease')), 'No worker held it, so there is no old run to wait for.');
    }

    public function testRenamingKeepsASyncError(): void
    {
        $headers = $this->userHeaders('kim@example.test', self::READ_WRITE);
        $this->client->jsonRequest('POST', '/api/v1/mail-accounts', $this->imapPayload(), $headers);
        $id = $this->responseString('id');
        static::getContainer()->get(EntityManagerInterface::class)->wrapInTransaction(fn () => $this->account($id)->setStatus(MailAccountStatus::Error, 'Could not connect to the mail server.'));

        $this->client->request('PATCH', '/api/v1/mail-accounts/'.$id, server: $headers + ['CONTENT_TYPE' => 'application/merge-patch+json'], content: '{"displayName":"Work mail"}');

        self::assertResponseIsSuccessful();
        self::assertSame('error', $this->decodedResponse()['status'] ?? null);
    }

    public function testUserCanPauseButNotSetSystemStatuses(): void
    {
        $headers = $this->userHeaders('kim@example.test', self::READ_WRITE);
        $this->client->jsonRequest('POST', '/api/v1/mail-accounts', $this->imapPayload(), $headers);
        $id = $this->responseString('id');
        $patch = $headers + ['CONTENT_TYPE' => 'application/merge-patch+json'];

        $this->client->request('PATCH', '/api/v1/mail-accounts/'.$id, server: $patch, content: '{"status":"paused"}');
        self::assertResponseIsSuccessful();
        self::assertSame('paused', $this->decodedResponse()['status'] ?? null);

        $this->client->request('PATCH', '/api/v1/mail-accounts/'.$id, server: $patch, content: '{"status":"auth_failed"}');
        self::assertResponseStatusCodeSame(422);
    }

    public function testDeleteRemovesAccount(): void
    {
        $headers = $this->userHeaders('kim@example.test', self::READ_WRITE);
        $this->client->jsonRequest('POST', '/api/v1/mail-accounts', $this->imapPayload(), $headers);
        $id = $this->responseString('id');

        $this->client->request('DELETE', '/api/v1/mail-accounts/'.$id, server: $headers);
        self::assertResponseStatusCodeSame(204);

        $this->client->request('GET', '/api/v1/mail-accounts/'.$id, server: $headers);
        self::assertResponseStatusCodeSame(404);
    }

    public function testWritingRequiresSettingsWriteScope(): void
    {
        $readOnly = $this->userHeaders('kim@example.test', ['settings:read']);

        $this->client->jsonRequest('POST', '/api/v1/mail-accounts', $this->imapPayload(), $readOnly);
        self::assertResponseStatusCodeSame(403);

        $this->client->request('GET', '/api/v1/mail-accounts', server: $readOnly);
        self::assertResponseIsSuccessful();
    }

    public function testSyncWorkerTokenCannotUseUserEndpoints(): void
    {
        $worker = $this->workerHeaders('sync:lease sync:credentials');

        $this->client->request('GET', '/api/v1/mail-accounts', server: $worker);

        self::assertResponseStatusCodeSame(403);
    }

    public function testRequiresToken(): void
    {
        $this->client->request('GET', '/api/v1/mail-accounts', server: ['HTTP_ACCEPT' => 'application/json']);

        self::assertResponseStatusCodeSame(401);
    }

    /**
     * @return array<string, mixed>
     */
    private function imapPayload(): array
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

    /**
     * A worker's heartbeat.
     *
     * @param array<string, string> $worker
     *
     * @return list<string> leased account ids
     */
    private function lease(string $workerId, array $worker): array
    {
        $this->client->jsonRequest('POST', '/internal/sync/leases', ['workerId' => $workerId, 'capacity' => 10], $worker);
        self::assertResponseIsSuccessful();
        $accounts = $this->decodedResponse()['accounts'] ?? null;
        self::assertIsArray($accounts);

        return array_values(array_map(static fn (mixed $account): string => \is_array($account) && \is_string($account['id'] ?? null) ? $account['id'] : '', $accounts));
    }

    private function account(string $id): MailAccount
    {
        $account = static::getContainer()->get(EntityManagerInterface::class)->find(MailAccount::class, Uuid::fromString($id));
        self::assertInstanceOf(MailAccount::class, $account);

        return $account;
    }
}
