<?php

declare(strict_types=1);

namespace App\Tests\Functional;

use App\Chat\ChatClaims;
use App\Chat\ChatOwnerLock;
use App\Realtime\RealtimeNotifier;
use App\Search\SearchIndexScheduler;
use App\Sync\Change\ChangeSequencer;
use Doctrine\DBAL\Connection;
use Doctrine\DBAL\DriverManager;
use Doctrine\DBAL\Exception as DBALException;
use Symfony\Component\Uid\Uuid;

/**
 * Chat writes of one user take turns on the user's row ({@see ChatOwnerLock}): two claims of one relay, or a claim and
 * an import, never hand out one reply twice. Uses two real connections outside the test transaction, because a lock
 * must be visible to another session.
 */
final class ChatConcurrencyTest extends DatabaseTestCase
{
    private Connection $one;
    private Connection $two;
    private Uuid $owner;
    private Uuid $account;
    private Uuid $device;

    /** @var list<string> */
    private array $replies;

    protected function setUp(): void
    {
        parent::setUp();
        $this->one = DriverManager::getConnection($this->separateConnectionParams());
        $this->two = DriverManager::getConnection($this->separateConnectionParams());
        $this->two->executeStatement("SET lock_timeout = '200ms'");

        $this->owner = Uuid::v7();
        $this->account = Uuid::v7();
        $this->device = Uuid::v7();
        $chat = Uuid::v7();
        $this->one->insert('app_user', [
            'id' => $this->owner->toRfc4122(), 'email' => 'chat-race-'.$this->owner->toRfc4122().'@example.test', 'password' => 'x',
            'display_name' => 'Race', 'roles' => '[]', 'created_at' => '2026-11-12 00:00:00', 'change_seq' => 0,
        ]);
        $this->one->insert('chat_account', [
            'id' => $this->account->toRfc4122(), 'owner_id' => $this->owner->toRfc4122(), 'channel' => 'whatsapp', 'relay_device_id' => $this->device->toRfc4122(),
            'relay_device_name' => 'Mac', 'relay_seen_at' => '2026-11-12 09:00:00', 'relay_online' => 'true', 'bridge_state' => 'running',
            'link_state' => 'linked', 'created_at' => '2026-11-12 09:00:00',
        ]);
        $this->one->insert('chat', [
            'id' => $chat->toRfc4122(), 'chat_account_id' => $this->account->toRfc4122(), 'jid_fingerprint' => str_repeat('a', 64), 'sealed_jid' => 'x',
            'kind' => 'direct', 'last_message_at' => '2026-11-12 09:00:00',
        ]);
        $this->replies = [];
        foreach ([1, 2] as $i) {
            $this->replies[] = $id = Uuid::v7()->toRfc4122();
            $this->one->insert('chat_outgoing', [
                'id' => $id, 'chat_id' => $chat->toRfc4122(), 'chat_account_id' => $this->account->toRfc4122(), 'sealed_text' => 'x'.$i,
                'status' => 'waiting', 'created_at' => '2026-11-12 09:00:00',
            ]);
        }
        // The sequencer queues search indexing for after the commit of the app's own connection.
        $this->connection()->beginTransaction();
    }

    protected function tearDown(): void
    {
        foreach ([$this->one, $this->two] as $connection) {
            if ($connection->isTransactionActive()) {
                $connection->rollBack();
            }
        }
        $this->connection()->rollBack();
        $this->one->delete('app_user', ['id' => $this->owner->toRfc4122()]);
        $this->one->close();
        $this->two->close();
        parent::tearDown();
    }

    public function testTwoClaimsRacingNeverTakeOneReply(): void
    {
        $this->one->beginTransaction();
        $first = $this->claims($this->one)->claim($this->owner, $this->account, $this->device, new \DateTimeImmutable())['id'] ?? null;
        self::assertSame($this->replies[0], $first);

        $this->two->beginTransaction();
        try {
            $this->claims($this->two)->claim($this->owner, $this->account, $this->device, new \DateTimeImmutable())['id'] ?? null;
            self::fail('A second claim went ahead while the first was open.');
        } catch (DBALException $e) {
            self::assertStringContainsString('lock', strtolower($e->getMessage()));
        }
        $this->two->rollBack();

        $this->one->commit();
        $this->two->beginTransaction();
        $second = $this->claims($this->two)->claim($this->owner, $this->account, $this->device, new \DateTimeImmutable())['id'] ?? null;
        $this->two->commit();

        self::assertSame($this->replies[1], $second, 'The second claim sees the first reply taken and gets the next.');
        self::assertSame(['sending', 'sending'], $this->one->fetchFirstColumn('SELECT status FROM chat_outgoing WHERE chat_account_id = :a ORDER BY id', ['a' => $this->account->toRfc4122()]));
        self::assertSame(2, $this->one->fetchOne('SELECT COUNT(DISTINCT change_seq) FROM chat_outgoing WHERE chat_account_id = :a', ['a' => $this->account->toRfc4122()]));
    }

    public function testAClaimWaitsForAnImportOfTheSameUser(): void
    {
        // An import holds the owner's row from its relay guard on, as every chat write does.
        $this->one->beginTransaction();
        new ChatOwnerLock($this->one)->lock($this->owner);

        $this->two->beginTransaction();
        try {
            $this->claims($this->two)->claim($this->owner, $this->account, $this->device, new \DateTimeImmutable())['id'] ?? null;
            self::fail('A claim went ahead during an import.');
        } catch (DBALException $e) {
            self::assertStringContainsString('lock', strtolower($e->getMessage()));
        }
        $this->two->rollBack();
        $this->one->commit();

        $this->two->beginTransaction();
        self::assertSame($this->replies[0], $this->claims($this->two)->claim($this->owner, $this->account, $this->device, new \DateTimeImmutable())['id'] ?? null);
        $this->two->commit();
    }

    /**
     * FOR NO KEY UPDATE serialises with what guards change numbers and keys, and leaves the KEY SHARE of an insert that
     * refers to the user alone.
     */
    public function testTheOwnerLockLetsReferencingInsertsThroughButNoChangeNumber(): void
    {
        $this->one->beginTransaction();
        new ChatOwnerLock($this->one)->lock($this->owner);
        $id = $this->owner->toRfc4122();

        self::assertSame($id, $this->two->fetchOne('SELECT id FROM app_user WHERE id = :id FOR KEY SHARE NOWAIT', ['id' => $id]), 'An insert referring to the user does not wait.');
        foreach ([
            'a change number' => 'UPDATE app_user SET change_seq = change_seq + 1 WHERE id = :id',
            'the keys, shared' => 'SELECT id FROM app_user WHERE id = :id FOR SHARE NOWAIT',
            'the keys' => 'SELECT id FROM app_user WHERE id = :id FOR UPDATE NOWAIT',
        ] as $what => $sql) {
            try {
                $this->two->executeStatement($sql, ['id' => $id]);
                self::fail($what.' went ahead during a chat write.');
            } catch (DBALException $e) {
                self::assertStringContainsString('lock', strtolower($e->getMessage()), $what);
            }
        }
        $this->one->commit();
    }

    private function claims(Connection $connection): ChatClaims
    {
        return new ChatClaims(
            $connection,
            new ChangeSequencer($connection, static::getContainer()->get(RealtimeNotifier::class), static::getContainer()->get(SearchIndexScheduler::class)),
            new ChatOwnerLock($connection),
        );
    }

    /**
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
}
