<?php

declare(strict_types=1);

namespace App\Tests\Functional;

use App\ApiResource\Input\Sync\FolderInput;
use App\Entity\MailAccount;
use App\Enum\FolderRole;
use App\Mailbox\MailboxChanges;
use App\Realtime\RealtimeNotifier;
use App\Search\SearchIndexScheduler;
use App\Security\Scope;
use App\Sync\Change\ChangeSequencer;
use App\Sync\Ingest\FolderSynchronizer;
use App\Sync\Ingest\MessageJanitor;
use App\Sync\Ingest\SweepOrphanedMessages;
use App\Sync\Ingest\SweepOrphanedMessagesHandler;
use Doctrine\DBAL\Connection;
use Doctrine\DBAL\DriverManager;
use Doctrine\DBAL\Exception as DBALException;
use Doctrine\ORM\EntityManagerInterface;
use Doctrine\Persistence\ManagerRegistry;
use Psr\Log\NullLogger;
use Symfony\Component\Clock\MockClock;
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
        $this->kim = $this->userHeaders('kim@example.test', ['mail:read', 'settings:read', 'settings:write', 'signatures:read', 'signatures:write']);

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

    public function testPagesEndWhereAFullCountWouldEndThem(): void
    {
        // Change numbers in many tables: accounts, folders, threads, messages, smart inboxes, signatures, tombstones.
        $this->client->jsonRequest('POST', '/api/v1/signatures', ['name' => 'Work', 'html' => '<p>Kim</p>'], $this->kim);
        self::assertResponseIsSuccessful();
        $this->ingest('changes', ['folder' => 'INBOX', 'flags' => [['remoteUid' => '1', 'flags' => ['seen' => true, 'flagged' => false, 'answered' => false, 'draft' => false]]]]);
        $this->ingest('changes', ['folder' => 'INBOX', 'vanished' => ['3']]);
        $this->ingest('messages', ['folder' => 'Archive', 'messages' => [$this->message('10', '<late@x>', 'Late')]]);
        $this->sweepOrphanedMessages();
        // The first pull from the start makes what a user from before had not synced yet (its calendar, say).
        $this->changes(0);

        foreach ([1, 2, 3, 7] as $limit) {
            $cursors = [];
            $cursor = 0;
            do {
                $page = $this->changes($cursor, $limit);
                $cursor = $page['cursor'];
                $cursors[] = $cursor;
            } while ($page['hasMore'] && \count($cursors) < 200);

            self::assertSame($this->cursorsByFullCount($limit), $cursors, 'limit '.$limit);
        }
    }

    /**
     * Every page says the newest change number of the user, so a client can tell how far behind it is: on the first
     * page of a paged pull it is ahead of the cursor, on the last page the pull is done (hasMore false).
     */
    public function testEachPageSaysTheNewestChangeNumber(): void
    {
        $this->changes(0);
        $newest = $this->changeNumberOf('kim@example.test');

        $first = $this->changes(0, 1);
        self::assertTrue($first['hasMore']);
        self::assertSame($newest, $first['latest']);
        self::assertGreaterThan($first['cursor'], $first['latest'], 'The first of several pages is behind the newest number.');

        $cursor = $first['cursor'];
        $pages = 1;
        do {
            $page = $this->changes($cursor, 1);
            self::assertSame($newest, $page['latest']);
            self::assertGreaterThanOrEqual($page['cursor'], $page['latest']);
            $cursor = $page['cursor'];
            ++$pages;
        } while ($page['hasMore'] && $pages < 50);

        self::assertFalse($page['hasMore'], 'The last page says no more follow.');
        self::assertLessThanOrEqual($newest, $page['cursor']);

        $nothingNew = $this->changes($cursor);
        self::assertSame($cursor, $nothingNew['cursor']);
        self::assertSame($newest, $nothingNew['latest'], 'An empty page says it too.');
    }

    /**
     * A number can be handed out whose rows a client never gets (rows changed again later, or of a kind left out): the
     * newest number then stays ahead of the last cursor, and only hasMore says the pull is over.
     */
    public function testTheNewestChangeNumberMayStayAheadOfTheLastPage(): void
    {
        $cursor = $this->changes(0)['cursor'];
        $this->connection()->executeStatement("UPDATE app_user SET change_seq = change_seq + 5 WHERE email = 'kim@example.test'");

        $page = $this->changes($cursor);

        self::assertFalse($page['hasMore']);
        self::assertSame($cursor, $page['cursor']);
        self::assertSame($cursor + 5, $page['latest']);
    }

    public function testTheNewestChangeNumberIsTheUsersOwn(): void
    {
        $this->changes(0);
        $lisa = $this->userHeaders('lisa@example.test', ['mail:read']);

        $this->client->request('GET', '/api/v1/sync/changes?since=0', server: $lisa);

        self::assertResponseIsSuccessful();
        $page = $this->decodedResponse();
        self::assertSame($this->changeNumberOf('lisa@example.test'), $page['latest']);
        self::assertNotSame($this->changeNumberOf('kim@example.test'), $page['latest']);
    }

    public function testALargeFolderDeletionIsPagedLikeAnyOtherChange(): void
    {
        $this->ingest('folders', ['folders' => [
            ['remoteName' => 'INBOX', 'displayName' => 'Inbox', 'role' => 'inbox', 'uidValidity' => 1],
            ['remoteName' => 'Archive', 'displayName' => 'Archive', 'role' => 'archive', 'uidValidity' => 1],
            ['remoteName' => 'Projects', 'displayName' => 'Projects', 'role' => 'custom', 'uidValidity' => 1],
        ]]);
        $this->ingest('messages', ['folder' => 'Projects', 'messages' => array_map(fn (int $i): array => $this->message((string) $i, '<project-'.$i.'@x>', 'Project '.$i), range(1, 7))]);
        $cursor = $this->changes(0)['cursor'];

        // Chunks of two instead of a thousand, to see them with a few messages.
        $container = static::getContainer();
        $sequencer = new ChangeSequencer($container->get(Connection::class), $container->get(RealtimeNotifier::class), $container->get(SearchIndexScheduler::class), 2);
        $janitor = new MessageJanitor($container->get(Connection::class), $sequencer, 2);
        $entityManager = $container->get(EntityManagerInterface::class);
        $account = $entityManager->find(MailAccount::class, Uuid::fromString($this->accountId));
        self::assertInstanceOf(MailAccount::class, $account);
        $folders = new FolderSynchronizer($entityManager, $container->get(Connection::class), $janitor, $sequencer, $container->get(MailboxChanges::class));
        $folders->sync($account, array_map(static function (array $folder): FolderInput {
            $input = new FolderInput();
            $input->remoteName = $folder[0];
            $input->displayName = $folder[0];
            $input->role = $folder[1];
            $input->uidValidity = 1;

            return $input;
        }, [['INBOX', FolderRole::Inbox], ['Archive', FolderRole::Archive]]));
        $entityManager->clear();
        new SweepOrphanedMessagesHandler($entityManager, $janitor, $container->get(ManagerRegistry::class), new MockClock(new \DateTimeImmutable('+16 minutes')), new NullLogger())(new SweepOrphanedMessages());

        $pages = [];
        do {
            $page = $this->changes($cursor, 5);
            $cursor = $page['cursor'];
            $rows = 0;
            foreach ($page as $value) {
                $rows += \is_array($value) ? \count($value) : 0;
            }
            $pages[] = [$rows, $page['hasMore']];
        } while ($page['hasMore'] && \count($pages) < 50);

        self::assertGreaterThan(3, \count($pages), 'Seven messages leave their folder and go in chunks of two.');
        foreach ($pages as [$rows, $hasMore]) {
            self::assertLessThanOrEqual(5, $rows);
        }
        self::assertSame(7, $this->countRows("SELECT COUNT(*) FROM sync_tombstone WHERE entity_type = 'message'"));
    }

    public function testUsersOnlySeeTheirOwnChanges(): void
    {
        $lisa = $this->userHeaders('lisa@example.test', ['mail:read', 'calendar:read', 'settings:read']);

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

    /**
     * The built-in smart inboxes share one change number. Rows of one number come in the order of their position, not
     * in the order Postgres happens to find them on disk: here two of them were rewritten after the others, and a
     * sequential scan meets the new row versions last.
     */
    public function testRowsOfOneChangeNumberComeInAStableOrder(): void
    {
        $this->connection()->executeStatement(
            "UPDATE category SET name = name WHERE builtin IN ('todo', 'informational') AND owner_id = (SELECT id FROM app_user WHERE email = 'kim@example.test')",
        );
        self::assertSame(1, $this->countRows("SELECT COUNT(DISTINCT change_seq) FROM category WHERE owner_id = (SELECT id FROM app_user WHERE email = 'kim@example.test')"), 'A tie on the change number.');
        $this->connection()->executeStatement('SET LOCAL enable_indexscan = off');
        $this->connection()->executeStatement('SET LOCAL enable_bitmapscan = off');

        $smartInboxes = $this->changes(0)['smartInboxes'];

        self::assertSame(['todo', 'informational', 'notification', 'advertise', 'spam'], array_column($smartInboxes, 'builtin'));
        self::assertSame([0, 1, 2, 3, 4], array_column($smartInboxes, 'position'));
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

    /**
     * A script or another app with only some scopes gets only the lists those scopes cover, as on their own endpoints;
     * the cursor is the same for every token.
     */
    public function testEachListNeedsItsOwnScope(): void
    {
        $everything = $this->userHeaders('kim@example.test', array_map(static fn (Scope $scope): string => $scope->value, Scope::personalAccessTokenScopes()));
        $this->client->jsonRequest('POST', '/api/v1/signatures', ['name' => 'Work', 'html' => '<p>Kim</p>'], $everything);
        self::assertResponseStatusCodeSame(201);
        $signatureId = $this->responseString('id');
        $this->client->jsonRequest('POST', '/api/v1/todos', ['title' => 'Call Anna'], $everything);
        self::assertResponseStatusCodeSame(201);
        $ownApp = $this->delta(0, $everything);
        foreach (['mailAccounts', 'calendars', 'todos', 'signatures', 'smartInboxes'] as $list) {
            self::assertNotSame([], $ownApp[$list], $list.' reaches our own app.');
        }

        $mailOnly = $this->delta(0, $this->personalAccessToken($everything, ['mail:read']));
        self::assertSame($ownApp['cursor'], $mailOnly['cursor']);
        self::assertSame(array_column($ownApp['mailAccounts'], 'id'), array_column($mailOnly['mailAccounts'], 'id'));
        self::assertCount(3, $mailOnly['messages']);
        foreach (['calendars', 'calendarEvents', 'notifications', 'eventNotes', 'todos', 'signatures', 'smartInboxes'] as $list) {
            self::assertSame([], $mailOnly[$list], $list.' needs its own scope.');
        }

        $withCalendar = $this->delta(0, $this->personalAccessToken($everything, ['mail:read', 'calendar:read']));
        self::assertSame(array_column($ownApp['calendars'], 'id'), array_column($withCalendar['calendars'], 'id'));
        self::assertSame([], $withCalendar['todos']);

        $cursor = $ownApp['cursor'];
        $this->client->request('DELETE', '/api/v1/signatures/'.$signatureId, server: $everything);
        self::assertResponseStatusCodeSame(204);
        $signatures = $this->personalAccessToken($everything, ['mail:read', 'signatures:read']);
        self::assertContains(['type' => 'signature', 'id' => $signatureId], $this->delta($cursor, $signatures)['deleted']);
        $after = $this->delta($cursor, $this->personalAccessToken($everything, ['mail:read']));
        self::assertNotContains(['type' => 'signature', 'id' => $signatureId], $after['deleted'], 'A removal is a change of its own kind.');
        self::assertGreaterThan($cursor, $after['cursor']);
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
     * @return array{cursor: int, hasMore: bool, latest: int, mailAccounts: list<array<string, mixed>>, folders: list<array<string, mixed>>, threads: list<array<string, mixed>>, messages: list<array<string, mixed>>, signatures: list<array<string, mixed>>, smartInboxes: list<array<string, mixed>>, todos: list<array<string, mixed>>, deleted: list<array{type: string, id: string}>}
     */
    private function changes(int $since, int $limit = 500): array
    {
        $this->client->request('GET', \sprintf('/api/v1/sync/changes?since=%d&limit=%d', $since, $limit), server: $this->kim);
        self::assertResponseIsSuccessful();

        /** @var array{cursor: int, hasMore: bool, latest: int, mailAccounts: list<array<string, mixed>>, folders: list<array<string, mixed>>, threads: list<array<string, mixed>>, messages: list<array<string, mixed>>, signatures: list<array<string, mixed>>, smartInboxes: list<array<string, mixed>>, todos: list<array<string, mixed>>, deleted: list<array{type: string, id: string}>} */
        return $this->decodedResponse();
    }

    /** The newest change number handed out to this user. */
    private function changeNumberOf(string $email): int
    {
        return $this->countRows('SELECT change_seq FROM app_user WHERE email = :email', ['email' => $email]);
    }

    /**
     * The page ends the delta had when it counted every change number left on every page: greedy pages of at most
     * $limit rows, never splitting a change number.
     *
     * @return list<int>
     */
    private function cursorsByFullCount(int $limit): array
    {
        $user = $this->connection()->fetchOne("SELECT id FROM app_user WHERE email = 'kim@example.test'");
        self::assertIsString($user);
        $rows = [];
        foreach ([
            'SELECT change_seq FROM mail_account WHERE owner_id = :user',
            'SELECT x.change_seq FROM folder x JOIN mail_account a ON a.id = x.mail_account_id WHERE a.owner_id = :user',
            'SELECT x.change_seq FROM thread x JOIN mail_account a ON a.id = x.mail_account_id WHERE a.owner_id = :user',
            'SELECT x.change_seq FROM message x JOIN mail_account a ON a.id = x.mail_account_id WHERE a.owner_id = :user',
            'SELECT x.change_seq FROM outgoing_message x JOIN mail_account a ON a.id = x.mail_account_id WHERE a.owner_id = :user',
            'SELECT x.change_seq FROM unsubscription x JOIN mail_account a ON a.id = x.mail_account_id WHERE a.owner_id = :user',
            'SELECT x.change_seq FROM calendar_event x JOIN calendar c ON c.id = x.calendar_id WHERE c.owner_id = :user',
            'SELECT change_seq FROM signature WHERE owner_id = :user',
            'SELECT change_seq FROM draft WHERE owner_id = :user AND sending_as_id IS NULL',
            'SELECT change_seq FROM category WHERE owner_id = :user',
            'SELECT change_seq FROM calendar WHERE owner_id = :user',
            'SELECT change_seq FROM scheduled_notification WHERE user_id = :user',
            'SELECT change_seq FROM event_note WHERE user_id = :user',
            'SELECT change_seq FROM todo WHERE owner_id = :user',
            'SELECT change_seq FROM mail_notification WHERE user_id = :user',
            'SELECT change_seq FROM hand_over WHERE owner_id = :user',
            'SELECT change_seq FROM daily_brief WHERE owner_id = :user',
            'SELECT change_seq FROM chat_account WHERE owner_id = :user',
            'SELECT x.change_seq FROM chat x JOIN chat_account a ON a.id = x.chat_account_id WHERE a.owner_id = :user',
            'SELECT x.change_seq FROM chat_message x JOIN chat_account a ON a.id = x.chat_account_id WHERE a.owner_id = :user',
            'SELECT x.change_seq FROM chat_outgoing x JOIN chat_account a ON a.id = x.chat_account_id WHERE a.owner_id = :user',
            'SELECT change_seq FROM sync_tombstone WHERE user_id = :user',
        ] as $sql) {
            foreach ($this->connection()->fetchFirstColumn($sql, ['user' => $user]) as $seq) {
                self::assertIsNumeric($seq);
                $rows[(int) $seq] = ($rows[(int) $seq] ?? 0) + 1;
            }
        }
        unset($rows[0]);
        ksort($rows);
        self::assertGreaterThan(8, \count($rows), 'Enough change numbers to need many pages.');

        $cursors = [];
        $until = 0;
        $total = 0;
        foreach ($rows as $seq => $count) {
            if ($total > 0 && $total + $count > $limit) {
                $cursors[] = $until;
                $total = 0;
            }
            $total += $count;
            $until = $seq;
        }
        $cursors[] = $until;

        return $cursors;
    }

    /**
     * @param array<string, string> $headers
     *
     * @return array{cursor: int, mailAccounts: list<array<string, mixed>>, messages: list<array<string, mixed>>, calendars: list<array<string, mixed>>, calendarEvents: list<array<string, mixed>>, notifications: list<array<string, mixed>>, eventNotes: list<array<string, mixed>>, todos: list<array<string, mixed>>, signatures: list<array<string, mixed>>, smartInboxes: list<array<string, mixed>>, deleted: list<array{type: string, id: string}>}
     */
    private function delta(int $since, array $headers): array
    {
        $this->client->request('GET', \sprintf('/api/v1/sync/changes?since=%d&limit=2000', $since), server: $headers);
        self::assertResponseIsSuccessful();

        /** @var array{cursor: int, mailAccounts: list<array<string, mixed>>, messages: list<array<string, mixed>>, calendars: list<array<string, mixed>>, calendarEvents: list<array<string, mixed>>, notifications: list<array<string, mixed>>, eventNotes: list<array<string, mixed>>, todos: list<array<string, mixed>>, signatures: list<array<string, mixed>>, smartInboxes: list<array<string, mixed>>, deleted: list<array{type: string, id: string}>} */
        return $this->decodedResponse();
    }

    /**
     * A personal access token with these scopes, made in our own app.
     *
     * @param array<string, string> $session
     * @param list<string>          $scopes
     *
     * @return array<string, string>
     */
    private function personalAccessToken(array $session, array $scopes): array
    {
        $this->client->jsonRequest('POST', '/api/v1/personal-access-tokens', ['name' => 'Script', 'scopes' => $scopes], $session);
        self::assertResponseStatusCodeSame(201);

        return ['HTTP_AUTHORIZATION' => 'Bearer '.$this->responseString('token'), 'HTTP_ACCEPT' => 'application/json'];
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
