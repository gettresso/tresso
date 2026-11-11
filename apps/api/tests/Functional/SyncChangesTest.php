<?php

declare(strict_types=1);

namespace App\Tests\Functional;

use App\Realtime\RealtimeNotifier;
use App\Search\SearchIndexScheduler;
use App\Sync\Change\ChangeSequencer;
use Doctrine\DBAL\DriverManager;
use Doctrine\DBAL\Exception as DBALException;
use Symfony\Component\Uid\Uuid;

final class SyncChangesTest extends DatabaseTestCase
{
    use AuthenticatesUsers;
    use StoresMail;

    private string $accountId;

    /** @var array<string, string> */
    private array $worker;

    /** @var array<string, string> */
    private array $kim;

    protected function setUp(): void
    {
        parent::setUp();
        $this->bootstrapOAuthClients();
        $this->createUser('kim@example.test', 'Kim');
        $this->createUser('lisa@example.test', 'Lisa');
        $this->kim = $this->userHeaders('kim@example.test', ['mail:read', 'settings:read', 'settings:write', 'signatures:write']);

        $this->client->jsonRequest('POST', '/api/v1/mail-accounts', [
            'emailAddress' => 'kim@company.example',
            'displayName' => 'Work',
            'username' => 'kim@company.example',
            'password' => 'app-password-1',
            'imap' => ['host' => 'imap.company.example', 'port' => 993, 'security' => 'tls'],
            'smtp' => ['host' => 'smtp.company.example', 'port' => 465, 'security' => 'tls'],
        ], $this->kim);
        $this->accountId = $this->responseString('id');

        $this->worker = $this->workerHeaders('sync:lease sync:ingest');
        $this->client->jsonRequest('POST', '/internal/sync/leases', ['workerId' => 'w1'], $this->worker);
        $this->ingest('folders', ['folders' => [
            ['remoteName' => 'INBOX', 'displayName' => 'Inbox', 'role' => 'inbox', 'uidValidity' => 1],
            ['remoteName' => 'Archive', 'displayName' => 'Archive', 'role' => 'archive', 'uidValidity' => 1],
        ]]);
        $this->ingest('messages', ['folder' => 'INBOX', 'messages' => [
            $this->message('1', '<root@x>', 'Offsite'),
            $this->message('2', '<reply@x>', 'Re: Offsite', '<root@x>'),
            $this->message('3', '<other@x>', 'Invoice'),
        ]]);
        $this->ingest('messages', ['folder' => 'Archive', 'messages' => [$this->message('9', '<other@x>', 'Invoice')]]);
    }

    public function testFullSyncReturnsEverythingWithFolderMembership(): void
    {
        $page = $this->changes(0);

        self::assertFalse($page['hasMore']);
        self::assertGreaterThan(0, $page['cursor']);
        self::assertSame([$this->accountId], array_column($page['mailAccounts'], 'id'));
        self::assertEqualsCanonicalizing(['INBOX', 'Archive'], array_column($page['folders'], 'name'));
        self::assertCount(2, $page['threads']);
        self::assertCount(3, $page['messages']);
        self::assertSame([], $page['deleted']);

        $folderIds = array_column($page['folders'], 'id', 'name');
        $invoice = $this->bySubject($page['messages'], 'Invoice');
        self::assertEqualsCanonicalizing([$folderIds['INBOX'], $folderIds['Archive']], $invoice['folderIds']);
        self::assertSame(['seen' => false, 'flagged' => false, 'answered' => false, 'draft' => false], $invoice['flags']);
        self::assertSame(['address' => 'sender@test.example', 'name' => 'Sender'], $invoice['from']);
        $offsite = $this->bySubject($page['messages'], 'Offsite');
        self::assertSame($offsite['threadId'], $this->bySubject($page['messages'], 'Re: Offsite')['threadId']);
    }

    public function testNothingNewKeepsTheCursor(): void
    {
        $cursor = $this->changes(0)['cursor'];

        $page = $this->changes($cursor);

        self::assertSame($cursor, $page['cursor']);
        self::assertFalse($page['hasMore']);
        self::assertSame([], [...$page['mailAccounts'], ...$page['folders'], ...$page['threads'], ...$page['messages'], ...$page['signatures'], ...$page['smartInboxes'], ...$page['todos'], ...$page['deleted']]);
    }

    public function testFlagChangeReturnsOnlyThatMessage(): void
    {
        $cursor = $this->changes(0)['cursor'];

        $this->ingest('changes', ['folder' => 'INBOX', 'flags' => [['remoteUid' => '1', 'flags' => ['seen' => true]]]]);
        $page = $this->changes($cursor);

        self::assertSame(['Offsite'], array_column($page['messages'], 'subject'));
        self::assertSame(['seen' => true, 'flagged' => false, 'answered' => false, 'draft' => false], $page['messages'][0]['flags']);
        self::assertSame([], $page['threads']);
    }

    public function testInternalUpdatesAreNotChangesForClients(): void
    {
        $cursor = $this->changes(0)['cursor'];

        // Only the folder's sync cursor and the account's lease change.
        $this->ingest('changes', ['folder' => 'INBOX', 'cursor' => 'uidnext=42']);
        $this->client->jsonRequest('POST', '/internal/sync/leases', ['workerId' => 'w1'], $this->worker);

        $page = $this->changes($cursor);
        self::assertSame($cursor, $page['cursor']);
        self::assertSame([], [...$page['mailAccounts'], ...$page['folders']]);
    }

    public function testRemovalsLeaveTombstonesAndUpdateMembership(): void
    {
        $first = $this->changes(0);
        $cursor = $first['cursor'];
        $threadOf = array_column($first['messages'], 'threadId', 'subject');

        $this->ingest('changes', ['folder' => 'INBOX', 'vanished' => ['2', '3']]);
        $page = $this->changes($cursor);

        self::assertSame([], $page['deleted'], 'The reply waits for its copy to show up elsewhere.');
        self::assertSame([], $this->bySubject($page['messages'], 'Re: Offsite')['folderIds'], 'Meanwhile it is in no folder.');

        $this->sweepOrphanedMessages();
        $page = $this->changes($cursor);

        self::assertContains(['type' => 'message', 'id' => $this->bySubject($first['messages'], 'Re: Offsite')['id']], $page['deleted']);
        self::assertSame(['Invoice'], array_column($page['messages'], 'subject'), 'Still in Archive, now only there.');
        self::assertSame([array_column($first['folders'], 'id', 'name')['Archive']], $page['messages'][0]['folderIds']);
        self::assertSame([$threadOf['Offsite']], array_column($page['threads'], 'id'), 'The thread lost a message and was recounted.');
        self::assertSame(1, $page['threads'][0]['messageCount']);
    }

    public function testEmptiedThreadIsDeleted(): void
    {
        $first = $this->changes(0);
        $this->ingest('changes', ['folder' => 'INBOX', 'vanished' => ['1', '2']]);
        $this->sweepOrphanedMessages();

        $page = $this->changes($first['cursor']);

        self::assertContains(['type' => 'thread', 'id' => $this->bySubject($first['messages'], 'Offsite')['threadId']], $page['deleted']);
    }

    public function testDeletedFolderIsReportedAndItsMessagesUpdated(): void
    {
        $first = $this->changes(0);
        $archiveId = array_column($first['folders'], 'id', 'name')['Archive'];

        $this->ingest('folders', ['folders' => [['remoteName' => 'INBOX', 'displayName' => 'Inbox', 'role' => 'inbox', 'uidValidity' => 1]]]);
        $page = $this->changes($first['cursor']);

        self::assertContains(['type' => 'folder', 'id' => $archiveId], $page['deleted']);
        self::assertSame([array_column($first['folders'], 'id', 'name')['INBOX']], $this->bySubject($page['messages'], 'Invoice')['folderIds']);
    }

    public function testDeletedAccountIsReported(): void
    {
        $cursor = $this->changes(0)['cursor'];

        $this->client->request('DELETE', '/api/v1/mail-accounts/'.$this->accountId, server: $this->kim);
        self::assertResponseStatusCodeSame(204);
        $page = $this->changes($cursor);

        self::assertSame([['type' => 'mailAccount', 'id' => $this->accountId]], $page['deleted']);
    }

    public function testSignatureAndAccountDefaultReachClients(): void
    {
        $cursor = $this->changes(0)['cursor'];

        $this->client->jsonRequest('POST', '/api/v1/signatures', ['name' => 'Work', 'html' => '<p>Kim</p>', 'defaultFor' => [$this->accountId]], $this->kim);
        self::assertResponseStatusCodeSame(201);
        $signatureId = $this->responseString('id');
        $page = $this->changes($cursor);

        self::assertSame([$signatureId], array_column($page['signatures'], 'id'));
        self::assertSame('Work', $page['signatures'][0]['name']);
        self::assertSame('<p>Kim</p>', $page['signatures'][0]['html']);
        self::assertSame([$signatureId], array_column($page['mailAccounts'], 'defaultSignatureId'));
    }

    public function testDeletedSignatureIsReportedAndTheDefaultCleared(): void
    {
        $this->client->jsonRequest('POST', '/api/v1/signatures', ['name' => 'Work', 'html' => '<p>Kim</p>', 'defaultFor' => [$this->accountId]], $this->kim);
        $signatureId = $this->responseString('id');
        $cursor = $this->changes(0)['cursor'];

        $this->client->request('DELETE', '/api/v1/signatures/'.$signatureId, server: $this->kim);
        self::assertResponseStatusCodeSame(204);
        $page = $this->changes($cursor);

        self::assertSame([['type' => 'signature', 'id' => $signatureId]], $page['deleted']);
        self::assertSame([$this->accountId], array_column($page['mailAccounts'], 'id'));
        self::assertNull($page['mailAccounts'][0]['defaultSignatureId']);
    }

    public function testPagesNeverSplitAChangeNumber(): void
    {
        $full = $this->changes(0);
        $seen = [];
        $cursor = 0;
        $pages = 0;

        do {
            $page = $this->changes($cursor, 1);
            self::assertGreaterThan($cursor, $page['cursor']);
            $cursor = $page['cursor'];
            foreach (['mailAccounts', 'folders', 'threads', 'messages'] as $type) {
                foreach ($page[$type] as $entity) {
                    $seen[$type][] = $entity['id'];
                }
            }
            ++$pages;
        } while ($page['hasMore'] && $pages < 50);

        self::assertSame($full['cursor'], $cursor);
        self::assertGreaterThan(1, $pages);
        foreach (['mailAccounts', 'folders', 'threads', 'messages'] as $type) {
            self::assertEqualsCanonicalizing(array_column($full[$type], 'id'), $seen[$type] ?? [], $type.' differ between paged and full sync.');
        }
    }

    public function testUsersOnlySeeTheirOwnChanges(): void
    {
        $lisa = $this->userHeaders('lisa@example.test', ['mail:read']);

        $this->client->request('GET', '/api/v1/sync/changes?since=0', server: $lisa);

        self::assertResponseIsSuccessful();
        /** @var array{cursor: int, mailAccounts: list<mixed>, folders: list<mixed>, threads: list<mixed>, messages: list<mixed>, smartInboxes: list<array<string, mixed>>} $page */
        $page = $this->decodedResponse();
        self::assertSame(1, $page['cursor'], 'Only the built-in smart inboxes and the calendar Lisa got with her account.');
        self::assertSame([], [...$page['mailAccounts'], ...$page['folders'], ...$page['threads'], ...$page['messages']]);
        $lisasSmartInboxes = $this->connection()->fetchFirstColumn("SELECT c.id FROM category c JOIN app_user u ON u.id = c.owner_id WHERE u.email = 'lisa@example.test'");
        self::assertEqualsCanonicalizing($lisasSmartInboxes, array_column($page['smartInboxes'], 'id'));
        $calendars = $this->decodedResponse()['calendars'];
        self::assertIsArray($calendars);
        self::assertSame(['Tresso'], array_column($calendars, 'name'), 'Only her own local calendar.');
    }

    public function testSmartInboxesReachClients(): void
    {
        $first = $this->changes(0);
        self::assertSame(['todo', 'informational', 'notification', 'advertise', 'spam'], array_column($first['smartInboxes'], 'builtin'));

        $this->client->jsonRequest('POST', '/api/v1/smart-inboxes', ['name' => 'Invoices', 'includeSenders' => ['@supplier.example'], 'verdict' => 'do'], $this->kim);
        self::assertResponseStatusCodeSame(201);
        $id = $this->responseString('id');
        $page = $this->changes($first['cursor']);

        self::assertSame([[
            'id' => $id,
            'builtin' => null,
            'name' => 'Invoices',
            'instructions' => '',
            'includeSenders' => ['@supplier.example'],
            'excludeSenders' => [],
            'verdict' => 'do',
            'autoCreateTodo' => false,
            'batchDelivery' => false,
            'position' => 5,
        ]], $page['smartInboxes']);

        $this->client->request('DELETE', '/api/v1/smart-inboxes/'.$id, server: $this->kim);
        self::assertResponseStatusCodeSame(204);
        self::assertContains(['type' => 'smartInbox', 'id' => $id], $this->changes($page['cursor'])['deleted']);
    }

    public function testRequiresMailReadScope(): void
    {
        $this->client->request('GET', '/api/v1/sync/changes', server: $this->userHeaders('kim@example.test', ['settings:read']));

        self::assertResponseStatusCodeSame(403);
    }

    public function testRejectsInvalidParameters(): void
    {
        $this->client->request('GET', '/api/v1/sync/changes?since=-1', server: $this->kim);
        self::assertResponseStatusCodeSame(422);

        $this->client->request('GET', '/api/v1/sync/changes?limit=5000', server: $this->kim);
        self::assertResponseStatusCodeSame(422);
    }

    /**
     * Uses two real connections outside the test transaction, because the lock must be visible to another session.
     */
    public function testChangeNumberHoldsTheUsersRowLockUntilCommit(): void
    {
        $writer = DriverManager::getConnection($this->separateConnectionParams());
        $other = DriverManager::getConnection($this->separateConnectionParams());
        $userId = Uuid::v7();
        $writer->insert('app_user', [
            'id' => $userId->toRfc4122(), 'email' => 'lock-'.$userId->toRfc4122().'@example.test', 'password' => 'x',
            'display_name' => 'Lock test', 'roles' => '[]', 'created_at' => '2026-10-19 00:00:00', 'change_seq' => 0,
        ]);

        // The sequencer queues search indexing for after the commit of the app's own connection.
        $this->connection()->beginTransaction();
        try {
            $writer->beginTransaction();
            $seq = new ChangeSequencer($writer, static::getContainer()->get(RealtimeNotifier::class), static::getContainer()->get(SearchIndexScheduler::class))->next($userId);
            self::assertSame(1, $seq);

            $other->executeStatement("SET lock_timeout = '200ms'");
            try {
                $other->fetchOne('SELECT change_seq FROM app_user WHERE id = :id FOR UPDATE', ['id' => $userId->toRfc4122()]);
                self::fail('A second writer got the lock while the first transaction was still open.');
            } catch (DBALException $e) {
                self::assertStringContainsString('lock', strtolower($e->getMessage()));
            }

            $writer->commit();
            self::assertEquals(1, $other->fetchOne('SELECT change_seq FROM app_user WHERE id = :id FOR UPDATE NOWAIT', ['id' => $userId->toRfc4122()]), 'After commit the next writer proceeds and sees the number.');
        } finally {
            if ($writer->isTransactionActive()) {
                $writer->rollBack();
            }
            $this->connection()->rollBack();
            $writer->delete('app_user', ['id' => $userId->toRfc4122()]);
            $writer->close();
            $other->close();
        }
    }

    public function testChangeNumbersOutsideATransactionAreRefused(): void
    {
        $this->expectException(\LogicException::class);

        static::getContainer()->get(ChangeSequencer::class)->next($this->userIdOf('kim@example.test'));
    }

    /**
     * @param array<string, mixed> $payload
     */
    private function ingest(string $action, array $payload): void
    {
        $this->client->jsonRequest('POST', '/internal/sync/accounts/'.$this->accountId.'/'.$action, ['workerId' => 'w1'] + $payload, $this->worker);
        self::assertResponseIsSuccessful();
    }

    /**
     * @return array{cursor: int, hasMore: bool, mailAccounts: list<array<string, mixed>>, folders: list<array<string, mixed>>, threads: list<array<string, mixed>>, messages: list<array<string, mixed>>, signatures: list<array<string, mixed>>, smartInboxes: list<array<string, mixed>>, todos: list<array<string, mixed>>, deleted: list<array{type: string, id: string}>}
     */
    private function changes(int $since, int $limit = 500): array
    {
        $this->client->request('GET', \sprintf('/api/v1/sync/changes?since=%d&limit=%d', $since, $limit), server: $this->kim);
        self::assertResponseIsSuccessful();

        /** @var array{cursor: int, hasMore: bool, mailAccounts: list<array<string, mixed>>, folders: list<array<string, mixed>>, threads: list<array<string, mixed>>, messages: list<array<string, mixed>>, signatures: list<array<string, mixed>>, smartInboxes: list<array<string, mixed>>, todos: list<array<string, mixed>>, deleted: list<array{type: string, id: string}>} */
        return $this->decodedResponse();
    }

    /**
     * @param list<array<string, mixed>> $messages
     *
     * @return array<string, mixed>
     */
    private function bySubject(array $messages, string $subject): array
    {
        foreach ($messages as $message) {
            if ($message['subject'] === $subject) {
                return $message;
            }
        }
        self::fail('No message with subject '.$subject);
    }

    /**
     * @return array<string, mixed>
     */
    private function message(string $uid, string $messageId, string $subject, ?string $inReplyTo = null): array
    {
        return [
            'remoteUid' => $uid,
            'rawObjectKey' => $this->rawKeyFor($this->accountId, $uid.$messageId),
            'keyVersion' => 1,
            'size' => 100,
            'receivedAt' => '2026-10-19T08:00:00+00:00',
            'messageId' => $messageId,
            'inReplyTo' => $inReplyTo,
            'subject' => $subject,
            'from' => ['address' => 'sender@test.example', 'name' => 'Sender'],
            'to' => [['address' => 'kim@company.example']],
            'snippet' => 'Hello',
        ];
    }

    /**
     * Connection settings of the test database for a session outside the test transaction.
     *
     * @return array{driver: 'pdo_pgsql', host: string, port: int, user: string, password: string, dbname: string}
     */
    private function separateConnectionParams(): array
    {
        $params = $this->connection()->getParams();
        $host = $params['host'] ?? null;
        $user = $params['user'] ?? null;
        $password = $params['password'] ?? null;
        $dbname = $params['dbname'] ?? null;
        $port = $params['port'] ?? 5432;
        self::assertIsString($host);
        self::assertIsString($user);
        self::assertIsString($password);
        self::assertIsString($dbname);
        self::assertIsNumeric($port);

        return ['driver' => 'pdo_pgsql', 'host' => $host, 'port' => (int) $port, 'user' => $user, 'password' => $password, 'dbname' => $dbname];
    }

    private function userIdOf(string $email): Uuid
    {
        $id = $this->connection()->fetchOne('SELECT id FROM app_user WHERE email = :email', ['email' => $email]);
        self::assertIsString($id);

        return Uuid::fromString($id);
    }
}
