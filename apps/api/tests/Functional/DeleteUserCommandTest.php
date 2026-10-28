<?php

declare(strict_types=1);

namespace App\Tests\Functional;

use App\Account\PurgeDeletedUser;
use App\Search\MessageIndex;
use App\Security\Crypto\CryptoException;
use App\Security\Crypto\UserKeys;
use App\Storage\BlobKind;
use App\Storage\BlobVault;
use App\Tests\Support\InMemoryObjectStorage;
use Symfony\Bundle\FrameworkBundle\Console\Application;
use Symfony\Component\Console\Tester\CommandTester;
use Symfony\Component\Messenger\MessageBusInterface;
use Symfony\Component\Messenger\Stamp\ReceivedStamp;
use Symfony\Component\Messenger\Transport\InMemory\InMemoryTransport;
use Symfony\Component\Uid\Uuid;

final class DeleteUserCommandTest extends DatabaseTestCase
{
    use AuthenticatesUsers;
    use StoresMail;

    private const string RAW = "From: anna@finance.example\r\nSubject: Salary\r\n\r\nYour salary for October.\r\n";

    private string $kimAccount;
    private string $lisaAccount;
    private Uuid $kim;

    /** @var array<string, string> */
    private array $worker;

    protected function setUp(): void
    {
        parent::setUp();
        $this->bootstrapOAuthClients();
        $this->worker = $this->workerHeaders('sync:lease sync:ingest');
        $this->kimAccount = $this->userWithMail('kim');
        $this->lisaAccount = $this->userWithMail('lisa');
        $this->kim = $this->accountOwner($this->kimAccount);
    }

    public function testShredsTheKeysBeforeAnythingElse(): void
    {
        $rawKey = $this->rawKeyFor($this->kimAccount, self::RAW);

        $this->deleteKim()->assertCommandIsSuccessful();

        self::assertSame(0, $this->countRows('SELECT COUNT(*) FROM user_key WHERE owner_id = :id', ['id' => $this->kim->toRfc4122()]));
        self::assertTrue($this->storage()->has($rawKey), 'The object is still there until the purge runs');
        static::getContainer()->get(UserKeys::class)->reset();
        $this->expectException(CryptoException::class);
        static::getContainer()->get(BlobVault::class)->read($this->kim, $rawKey);
    }

    public function testRemovesTheUserAndEverythingTheyOwn(): void
    {
        $this->deleteKim()->assertCommandIsSuccessful();

        self::assertFalse($this->connection()->fetchOne("SELECT 1 FROM app_user WHERE email = 'kim@example.test'"));
        self::assertSame(0, $this->countRows('SELECT COUNT(*) FROM mail_account WHERE id = :id', ['id' => $this->kimAccount]));
        self::assertSame(0, $this->countRows('SELECT COUNT(*) FROM message WHERE mail_account_id = :id', ['id' => $this->kimAccount]));
        self::assertSame(0, $this->countRows("SELECT COUNT(*) FROM oauth2_access_token WHERE user_identifier = 'kim@example.test'"));
        self::assertSame(0, $this->countRows('SELECT COUNT(*) FROM organization WHERE personal_owner_id = :id', ['id' => $this->kim->toRfc4122()]));
        self::assertSame(0, $this->countRows('SELECT COUNT(*) FROM organization_member WHERE user_id = :id', ['id' => $this->kim->toRfc4122()]));
        self::assertSame(1, $this->countRows('SELECT COUNT(*) FROM organization o JOIN app_user u ON u.id = o.personal_owner_id WHERE u.email = :email', ['email' => 'lisa@example.test']), 'Lisa keeps her organization.');
        self::assertSame(1, $this->countRows('SELECT COUNT(*) FROM message WHERE mail_account_id = :id', ['id' => $this->lisaAccount]), 'Lisa keeps her mail.');
    }

    public function testPurgesTheObjectsAndSearchDocumentsOfOnlyThatUser(): void
    {
        $lisaRaw = $this->rawKeyFor($this->lisaAccount, self::RAW);
        self::assertSame(1, $this->indexed($this->kim));

        $this->deleteKim()->assertCommandIsSuccessful();
        $this->runQueued('async');

        foreach (BlobKind::cases() as $kind) {
            self::assertSame([], [...$this->storage()->list($kind->value.'/'.$this->kim->toRfc4122().'/')]);
        }
        self::assertTrue($this->storage()->has($lisaRaw));
        self::assertSame(self::RAW, static::getContainer()->get(BlobVault::class)->read($this->accountOwner($this->lisaAccount), $lisaRaw));
        self::assertSame(0, $this->indexed($this->kim));
        self::assertSame(1, $this->indexed($this->accountOwner($this->lisaAccount)));
    }

    public function testAsksBeforeDeleting(): void
    {
        $tester = new CommandTester(new Application($this->client->getKernel())->find('app:users:delete'));
        $tester->setInputs(['no']);
        $tester->execute(['email' => 'kim@example.test']);

        self::assertSame(1, $this->countRows("SELECT COUNT(*) FROM app_user WHERE email = 'kim@example.test'"));
        self::assertGreaterThan(0, $this->countRows('SELECT COUNT(*) FROM user_key WHERE owner_id = :id', ['id' => $this->kim->toRfc4122()]));
    }

    private function deleteKim(): CommandTester
    {
        $tester = new CommandTester(new Application($this->client->getKernel())->find('app:users:delete'));
        $tester->execute(['email' => 'kim@example.test', '--force' => true]);

        return $tester;
    }

    /** A user with one message (raw MIME and body text), signed in once. */
    private function userWithMail(string $name): string
    {
        $this->createUser($name.'@example.test', ucfirst($name));
        $this->client->jsonRequest('POST', '/api/v1/mail-accounts', [
            'emailAddress' => $name.'@company.example',
            'displayName' => 'Work',
            'username' => $name.'@company.example',
            'password' => 'app-password-1',
            'imap' => ['host' => 'imap.company.example', 'port' => 993, 'security' => 'tls'],
            'smtp' => ['host' => 'smtp.company.example', 'port' => 465, 'security' => 'tls'],
        ], $this->userHeaders($name.'@example.test', ['settings:write']));
        $accountId = $this->responseString('id');

        $this->client->jsonRequest('POST', '/internal/sync/leases', ['workerId' => 'w1'], $this->worker);
        $this->client->jsonRequest('POST', '/internal/sync/accounts/'.$accountId.'/folders', ['workerId' => 'w1', 'folders' => [
            ['remoteName' => 'INBOX', 'displayName' => 'Inbox', 'role' => 'inbox', 'uidValidity' => 1],
        ]], $this->worker);
        $this->client->jsonRequest('POST', '/internal/sync/accounts/'.$accountId.'/messages', ['workerId' => 'w1', 'folder' => 'INBOX', 'messages' => [[
            'remoteUid' => '1',
            'rawObjectKey' => $this->storeAsWorker($accountId, BlobKind::Raw, self::RAW),
            'keyVersion' => 1,
            'size' => \strlen(self::RAW),
            'receivedAt' => '2026-10-19T08:00:00+00:00',
            'messageId' => '<salary-'.$name.'@finance.example>',
            'subject' => 'Salary',
            'from' => ['address' => 'anna@finance.example', 'name' => 'Anna'],
            'to' => [['address' => $name.'@company.example']],
            'snippet' => 'Your salary',
            'bodyText' => 'Your salary for October.',
        ]]], $this->worker);
        self::assertResponseIsSuccessful();
        $this->runQueued('search');

        return $accountId;
    }

    private function runQueued(string $transportName): void
    {
        $transport = static::getContainer()->get('messenger.transport.'.$transportName);
        self::assertInstanceOf(InMemoryTransport::class, $transport);
        $envelopes = [...$transport->get()];
        $transport->reset();
        $bus = static::getContainer()->get(MessageBusInterface::class);
        foreach ($envelopes as $envelope) {
            if ('async' === $transportName && !$envelope->getMessage() instanceof PurgeDeletedUser) {
                continue;
            }
            $bus->dispatch($envelope->with(new ReceivedStamp($transportName)));
        }
        $index = static::getContainer()->get(MessageIndex::class);
        $index->waitFor($index->configure());
    }

    private function indexed(Uuid $owner): int
    {
        $response = static::getContainer()->get(MessageIndex::class)->search(['q' => '', 'filter' => 'ownerId = '.MessageIndex::quote($owner->toRfc4122()), 'hitsPerPage' => 0]);
        self::assertIsArray($response);
        self::assertIsInt($response['totalHits'] ?? null);

        return $response['totalHits'];
    }

    private function storage(): InMemoryObjectStorage
    {
        return static::getContainer()->get(InMemoryObjectStorage::class);
    }
}
