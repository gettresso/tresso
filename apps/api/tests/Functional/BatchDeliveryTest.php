<?php

declare(strict_types=1);

namespace App\Tests\Functional;

use App\Batch\BatchDelivery;
use App\Batch\ReleaseBatch;
use App\Batch\SweepBatches;
use Symfony\Component\Messenger\Envelope;
use Symfony\Component\Messenger\MessageBusInterface;
use Symfony\Component\Messenger\Stamp\DelayStamp;
use Symfony\Component\Messenger\Stamp\ReceivedStamp;
use Symfony\Component\Messenger\Transport\InMemory\InMemoryTransport;

/**
 * Batched delivery end to end: new mail of a smart inbox that delivers in batches is held for the user's next batch
 * time, clients see it held in the delta, and the batch releases it.
 */
final class BatchDeliveryTest extends DatabaseTestCase
{
    use AuthenticatesUsers;
    use StoresMail;

    private const string ME = 'kim@company.example';

    private string $accountId;

    /** @var array<string, string> */
    private array $worker;

    /** @var array<string, string> */
    private array $kim;

    private \DateTimeImmutable $nextBatch;

    protected function setUp(): void
    {
        parent::setUp();
        $this->bootstrapOAuthClients();
        $this->createUser('kim@example.test', 'Kim');
        $this->kim = $this->userHeaders('kim@example.test', ['mail:read', 'mail:write', 'settings:read', 'settings:write']);

        $this->client->jsonRequest('POST', '/api/v1/mail-accounts', [
            'emailAddress' => self::ME,
            'displayName' => 'Work',
            'username' => self::ME,
            'password' => 'app-password-1',
            'imap' => ['host' => 'imap.company.example', 'port' => 993, 'security' => 'tls'],
            'smtp' => ['host' => 'smtp.company.example', 'port' => 465, 'security' => 'tls'],
        ], $this->kim);
        $this->accountId = $this->responseString('id');

        // One batch a day, six hours from now: the last one went out 18 hours ago, whatever time the tests run.
        $inSixHours = new \DateTimeImmutable('+6 hours', new \DateTimeZone('UTC'));
        $this->nextBatch = $inSixHours->setTime((int) $inSixHours->format('G'), (int) $inSixHours->format('i'));
        $this->client->jsonRequest('PUT', '/api/v1/batch-delivery', ['times' => [$this->nextBatch->format('H:i')], 'timeZone' => 'UTC'], $this->kim);
        self::assertResponseIsSuccessful();

        $this->worker = $this->workerHeaders('sync:lease sync:ingest');
        $this->client->jsonRequest('POST', '/internal/sync/leases', ['workerId' => 'w1'], $this->worker);
        $this->ingest('folders', ['folders' => [['remoteName' => 'INBOX', 'displayName' => 'Inbox', 'role' => 'inbox', 'uidValidity' => 1]]]);
    }

    public function testTheScheduleHasDefaultsUntilTheUserChoosesTimes(): void
    {
        $this->createUser('lisa@example.test', 'Lisa');
        $lisa = $this->userHeaders('lisa@example.test', ['settings:read']);

        $this->client->request('GET', '/api/v1/batch-delivery', server: $lisa);

        self::assertResponseIsSuccessful();
        $body = $this->decodedResponse();
        self::assertSame(['09:00', '16:00'], $body['times']);
        self::assertSame('UTC', $body['timeZone']);
        self::assertFalse($body['configured']);
        self::assertIsString($body['nextBatchAt']);
    }

    public function testTheUserChoosesTimesInTheirZone(): void
    {
        $this->client->jsonRequest('PUT', '/api/v1/batch-delivery', ['times' => ['16:00', '08:30'], 'timeZone' => 'Europe/Amsterdam'], $this->kim);

        self::assertResponseIsSuccessful();
        $this->client->request('GET', '/api/v1/batch-delivery', server: $this->kim);
        $body = $this->decodedResponse();
        self::assertSame(['08:30', '16:00'], $body['times']);
        self::assertSame('Europe/Amsterdam', $body['timeZone']);
        self::assertTrue($body['configured']);
        self::assertContains(new \DateTimeImmutable(\is_string($body['nextBatchAt']) ? $body['nextBatchAt'] : '')->setTimezone(new \DateTimeZone('Europe/Amsterdam'))->format('H:i'), ['08:30', '16:00']);
    }

    public function testInvalidSchedulesAreRefused(): void
    {
        foreach ([
            ['times' => [], 'timeZone' => 'UTC'],
            ['times' => ['9:00'], 'timeZone' => 'UTC'],
            ['times' => ['09:00', '09:00'], 'timeZone' => 'UTC'],
            ['times' => ['09:00'], 'timeZone' => 'Mars/Olympus'],
            ['times' => array_map(static fn (int $h): string => \sprintf('%02d:00', $h), range(1, 9)), 'timeZone' => 'UTC'],
        ] as $schedule) {
            $this->client->jsonRequest('PUT', '/api/v1/batch-delivery', $schedule, $this->kim);
            self::assertResponseStatusCodeSame(422, json_encode($schedule, \JSON_THROW_ON_ERROR));
        }
    }

    public function testNewAdvertisingMailIsHeldForTheNextBatch(): void
    {
        $this->ingest('messages', ['folder' => 'INBOX', 'messages' => [$this->newsletter('1', 'Weekly deals', '-1 hour')]]);
        $this->runQueued('classify');

        // Read before the next request: the test client empties the in-memory transports on every request.
        $releases = $this->queued('async', ReleaseBatch::class);
        self::assertCount(1, $releases, 'The release is announced once, for the batch time.');
        $delay = $releases[0]->last(DelayStamp::class);
        self::assertNotNull($delay);
        self::assertEqualsWithDelta(6 * 3600 * 1000, $delay->getDelay(), 120 * 1000);

        $page = $this->changes(0);
        $thread = $this->threadBySubject($page, 'Weekly deals');
        $message = $this->messageBySubject($page, 'Weekly deals');
        self::assertSame($this->nextBatch->format(\DATE_ATOM), $thread['heldUntil']);
        self::assertSame($this->nextBatch->format(\DATE_ATOM), $message['heldUntil']);
        self::assertNull($thread['batchedAt']);
    }

    public function testMailThatIsReadOrOlderThanTheLastBatchOrFromAPersonIsDeliveredAsItComes(): void
    {
        $this->ingest('messages', ['folder' => 'INBOX', 'messages' => [
            $this->newsletter('1', 'Old deals', '-2 days'),
            $this->newsletter('2', 'Read deals', '-1 hour', ['seen' => true]),
            $this->message('3', 'Budget', '-1 hour'),
        ]]);
        $this->runQueued('classify');

        $page = $this->changes(0);
        foreach (['Old deals', 'Read deals', 'Budget'] as $subject) {
            self::assertNull($this->threadBySubject($page, $subject)['heldUntil'], $subject);
        }
    }

    public function testTheBatchReleasesHeldMail(): void
    {
        $this->ingest('messages', ['folder' => 'INBOX', 'messages' => [$this->newsletter('1', 'Weekly deals', '-1 hour')]]);
        $this->runQueued('classify');
        $releases = $this->queued('async', ReleaseBatch::class);
        $cursor = $this->changes(0)['cursor'];

        $this->batchTimeHasCome();
        $bus = static::getContainer()->get(MessageBusInterface::class);
        foreach ($releases as $release) {
            $bus->dispatch($release->with(new ReceivedStamp('async')));
        }

        $page = $this->changes($cursor);
        $thread = $this->threadBySubject($page, 'Weekly deals');
        self::assertNull($thread['heldUntil']);
        self::assertSame($this->nextBatch->format(\DATE_ATOM), $thread['batchedAt']);
        self::assertSame($this->nextBatch->format(\DATE_ATOM), $this->messageBySubject($page, 'Weekly deals')['batchedAt']);
    }

    public function testTheSweepReleasesABatchWhoseMessageGotLostAlsoForAnAccountNobodyLeases(): void
    {
        $this->ingest('messages', ['folder' => 'INBOX', 'messages' => [$this->newsletter('1', 'Weekly deals', '-1 hour')]]);
        $this->runQueued('classify');
        $this->batchTimeHasCome();
        $this->connection()->executeStatement('UPDATE mail_account SET leased_by = NULL, lease_expires_at = NULL');

        static::getContainer()->get(MessageBusInterface::class)->dispatch(new SweepBatches());

        $thread = $this->threadBySubject($this->changes(0), 'Weekly deals');
        self::assertNull($thread['heldUntil']);
        self::assertSame($this->nextBatch->format(\DATE_ATOM), $thread['batchedAt']);
    }

    public function testTheSweepGoesOnPastAUserWhoseReleaseFails(): void
    {
        $this->ingest('messages', ['folder' => 'INBOX', 'messages' => [$this->newsletter('1', 'Weekly deals', '-1 hour')]]);
        $this->runQueued('classify');
        $this->batchTimeHasCome();

        // Lisa's held mail is the longest overdue, so the sweep comes to her first, and releasing it fails.
        $this->createUser('lisa@example.test', 'Lisa');
        $this->client->jsonRequest('POST', '/api/v1/mail-accounts', [
            'emailAddress' => 'lisa@company.example',
            'displayName' => 'Work',
            'username' => 'lisa@company.example',
            'password' => 'app-password-1',
            'imap' => ['host' => 'imap.company.example', 'port' => 993, 'security' => 'tls'],
            'smtp' => ['host' => 'smtp.company.example', 'port' => 465, 'security' => 'tls'],
        ], $this->userHeaders('lisa@example.test', ['settings:write']));
        $lisasAccount = $this->responseString('id');
        $this->client->jsonRequest('POST', '/internal/sync/leases', ['workerId' => 'w1'], $this->worker);
        $this->client->jsonRequest('POST', '/internal/sync/accounts/'.$lisasAccount.'/folders', ['workerId' => 'w1', 'folders' => [['remoteName' => 'INBOX', 'displayName' => 'Inbox', 'role' => 'inbox', 'uidValidity' => 1]]], $this->worker);
        self::assertResponseIsSuccessful();
        $this->client->jsonRequest('POST', '/internal/sync/accounts/'.$lisasAccount.'/messages', ['workerId' => 'w1', 'folder' => 'INBOX', 'messages' => [
            ['rawObjectKey' => $this->rawKeyFor($lisasAccount, 'lisa-1')] + $this->message('1', 'Lisa deals', '-1 hour'),
        ]], $this->worker);
        self::assertResponseIsSuccessful();
        $connection = $this->connection();
        foreach (['message', 'thread'] as $table) {
            $connection->executeStatement("UPDATE {$table} SET held_until = :at WHERE mail_account_id = :account", ['at' => new \DateTimeImmutable('-1 hour', new \DateTimeZone('UTC'))->format('Y-m-d H:i:s'), 'account' => $lisasAccount]);
        }
        $connection->executeStatement("CREATE FUNCTION refuse_release() RETURNS trigger AS $$ BEGIN RAISE EXCEPTION 'refused'; END $$ LANGUAGE plpgsql");
        $connection->executeStatement("CREATE TRIGGER refuse_release BEFORE UPDATE ON message FOR EACH ROW WHEN (OLD.mail_account_id = '{$lisasAccount}') EXECUTE FUNCTION refuse_release()");

        static::getContainer()->get(MessageBusInterface::class)->dispatch(new SweepBatches());

        $thread = $this->threadBySubject($this->changes(0), 'Weekly deals');
        self::assertNull($thread['heldUntil'], 'Kim\'s batch went out although Lisa\'s failed.');
        self::assertSame($this->nextBatch->format(\DATE_ATOM), $thread['batchedAt']);
    }

    public function testATimeZoneAliasBrowsersStillReportIsAccepted(): void
    {
        $this->client->jsonRequest('PUT', '/api/v1/batch-delivery', ['times' => ['09:00'], 'timeZone' => 'Asia/Calcutta'], $this->kim);

        self::assertResponseIsSuccessful();
        self::assertSame('Asia/Calcutta', $this->responseString('timeZone'));
    }

    public function testChangingTheTimesMovesAllHeldMailHoweverMuchWaits(): void
    {
        $count = BatchDelivery::RELEASE_BATCH + 1;
        for ($start = 1; $start <= $count; $start += 200) {
            $part = [];
            for ($uid = $start; $uid < min($start + 200, $count + 1); ++$uid) {
                $part[] = $this->newsletter((string) $uid, 'Deals '.$uid, '-1 hour');
            }
            $this->ingest('messages', ['folder' => 'INBOX', 'messages' => $part]);
        }
        $this->runQueued('classify');
        self::assertSame($count, self::number($this->connection()->fetchOne('SELECT COUNT(*) FROM message WHERE held_until IS NOT NULL')));
        $later = $this->nextBatch->modify('+1 hour');

        $this->client->jsonRequest('PUT', '/api/v1/batch-delivery', ['times' => [$later->format('H:i')], 'timeZone' => 'UTC'], $this->kim);

        self::assertResponseIsSuccessful();
        foreach (['message', 'thread'] as $table) {
            self::assertSame($count, self::number($this->connection()->fetchOne("SELECT COUNT(*) FROM {$table} WHERE held_until = :at", ['at' => $later->format('Y-m-d H:i:s')])), $table);
        }
    }

    public function testMovingAConversationDeliversAllOfItsHeldMail(): void
    {
        $this->ingest('messages', ['folder' => 'INBOX', 'messages' => [
            $this->newsletter('1', 'Weekly deals', '-2 hours', ['messageId' => '<deals-1@shop.example>']),
            $this->newsletter('2', 'Re: Weekly deals', '-1 hour', ['messageId' => '<deals-2@shop.example>', 'inReplyTo' => '<deals-1@shop.example>']),
        ]]);
        $this->runQueued('classify');
        self::assertSame(2, self::number($this->connection()->fetchOne('SELECT COUNT(*) FROM message WHERE held_until IS NOT NULL')));
        $page = $this->changes(0);
        $thread = $this->threadBySubject($page, 'Weekly deals');

        $this->client->jsonRequest('PUT', '/api/v1/threads/'.self::text($thread['id']).'/classification', ['smartInboxId' => $this->smartInbox($page, 'informational')['id']], $this->kim);

        self::assertResponseIsSuccessful();
        self::assertSame(0, self::number($this->connection()->fetchOne('SELECT COUNT(*) FROM message WHERE held_until IS NOT NULL')), 'The older one does not arrive later with its batch.');
    }

    public function testAnOlderMessageSyncedLateIntoAConversationInSightIsNotHeld(): void
    {
        $this->ingest('messages', ['folder' => 'INBOX', 'messages' => [$this->message('1', 'Order 123', '-1 hour', ['messageId' => '<order-1@shop.example>'])]]);
        $this->runQueued('classify');

        $this->ingest('messages', ['folder' => 'INBOX', 'messages' => [
            $this->newsletter('2', 'Re: Order 123', '-90 minutes', ['messageId' => '<order-0@shop.example>', 'references' => ['<order-1@shop.example>']]),
        ]]);
        $this->runQueued('classify');

        self::assertSame(0, self::number($this->connection()->fetchOne('SELECT COUNT(*) FROM message WHERE held_until IS NOT NULL')));
        self::assertNull($this->threadBySubject($this->changes(0), 'Order 123')['heldUntil']);
    }

    public function testChangingTheTimesMovesHeldMailToTheNewNextBatch(): void
    {
        $this->ingest('messages', ['folder' => 'INBOX', 'messages' => [$this->newsletter('1', 'Weekly deals', '-1 hour')]]);
        $this->runQueued('classify');
        $later = $this->nextBatch->modify('+1 hour');

        $this->client->jsonRequest('PUT', '/api/v1/batch-delivery', ['times' => [$later->format('H:i')], 'timeZone' => 'UTC'], $this->kim);

        self::assertResponseIsSuccessful();
        self::assertSame($later->format(\DATE_ATOM), $this->threadBySubject($this->changes(0), 'Weekly deals')['heldUntil']);
    }

    public function testSwitchingBatchesOffForASmartInboxDeliversItsHeldMailAtOnce(): void
    {
        $this->ingest('messages', ['folder' => 'INBOX', 'messages' => [$this->newsletter('1', 'Weekly deals', '-1 hour')]]);
        $this->runQueued('classify');
        $page = $this->changes(0);
        $advertise = $this->smartInbox($page, 'advertise');
        self::assertTrue($advertise['batchDelivery']);

        $this->client->request('PATCH', '/api/v1/smart-inboxes/'.self::text($advertise['id']), server: $this->kim + ['CONTENT_TYPE' => 'application/merge-patch+json'], content: '{"batchDelivery": false}');

        self::assertResponseIsSuccessful();
        self::assertFalse($this->decodedResponse()['batchDelivery']);
        $after = $this->changes($page['cursor']);
        $thread = $this->threadBySubject($after, 'Weekly deals');
        self::assertNull($thread['heldUntil']);
        self::assertNull($thread['batchedAt'], 'Delivered as it came, not with a batch.');
        self::assertFalse($this->smartInbox($after, 'advertise')['batchDelivery']);
    }

    public function testMovingAHeldConversationDeliversItAtOnce(): void
    {
        $this->ingest('messages', ['folder' => 'INBOX', 'messages' => [$this->newsletter('1', 'Weekly deals', '-1 hour')]]);
        $this->runQueued('classify');
        $page = $this->changes(0);
        $thread = $this->threadBySubject($page, 'Weekly deals');

        $this->client->jsonRequest('PUT', '/api/v1/threads/'.self::text($thread['id']).'/classification', ['smartInboxId' => $this->smartInbox($page, 'informational')['id']], $this->kim);

        self::assertResponseIsSuccessful();
        $after = $this->changes($page['cursor']);
        self::assertNull($this->threadBySubject($after, 'Weekly deals')['heldUntil']);
        self::assertNull($this->messageBySubject($after, 'Weekly deals')['heldUntil']);
    }

    private function batchTimeHasCome(): void
    {
        $aMinuteAgo = new \DateTimeImmutable('-1 minute', new \DateTimeZone('UTC'));
        $this->nextBatch = $aMinuteAgo->setTime((int) $aMinuteAgo->format('G'), (int) $aMinuteAgo->format('i'));
        foreach (['message', 'thread'] as $table) {
            $this->connection()->executeStatement("UPDATE {$table} SET held_until = :at WHERE held_until IS NOT NULL", ['at' => $this->nextBatch->format('Y-m-d H:i:s')]);
        }
    }

    /**
     * @param array<string, mixed> $override
     *
     * @return array<string, mixed>
     */
    private function newsletter(string $uid, string $subject, string $received, array $override = []): array
    {
        return $this->message($uid, $subject, $received, ['from' => ['address' => 'newsletter@shop.example', 'name' => 'Shop'], 'headers' => ['list-unsubscribe' => '<https://shop.example/u>'], ...$override]);
    }

    /**
     * @param array<string, mixed> $override
     *
     * @return array<string, mixed>
     */
    private function message(string $uid, string $subject, string $received, array $override = []): array
    {
        $sha = hash('sha256', $uid.$subject);
        $seen = (bool) ($override['seen'] ?? false);
        unset($override['seen']);

        return [...[
            'remoteUid' => $uid,
            'rawObjectKey' => $this->rawKeyFor($this->accountId, $uid.$subject),
            'keyVersion' => 1,
            'size' => 100,
            'receivedAt' => new \DateTimeImmutable($received)->format(\DATE_ATOM),
            'messageId' => '<'.$sha.'@x>',
            'subject' => $subject,
            'from' => ['address' => 'anna@partner.example', 'name' => 'Anna'],
            'to' => [['address' => self::ME]],
            'flags' => ['seen' => $seen, 'flagged' => false, 'answered' => false, 'draft' => false],
            'snippet' => 'Hello',
        ], ...$override];
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
     * Runs what was queued on a transport the way the messenger worker would, until nothing is left.
     */
    private function runQueued(string $transportName): void
    {
        $bus = static::getContainer()->get(MessageBusInterface::class);
        $transport = $this->transport($transportName);
        while ([] !== ($envelopes = array_values([...$transport->get()]))) {
            $transport->reset();
            foreach ($envelopes as $envelope) {
                $bus->dispatch($envelope->with(new ReceivedStamp($transportName)));
            }
        }
    }

    /**
     * @param class-string $class
     *
     * @return list<Envelope>
     */
    private function queued(string $transportName, string $class): array
    {
        // Sent, not get(): the transport holds delayed messages back until their time.
        return array_values(array_filter($this->transport($transportName)->getSent(), static fn (Envelope $e): bool => $e->getMessage() instanceof $class));
    }

    private function transport(string $name): InMemoryTransport
    {
        $transport = static::getContainer()->get('messenger.transport.'.$name);
        self::assertInstanceOf(InMemoryTransport::class, $transport);

        return $transport;
    }

    /**
     * @return array{cursor: int, smartInboxes: list<array<string, mixed>>, threads: list<array<string, mixed>>, messages: list<array<string, mixed>>}
     */
    private function changes(int $since): array
    {
        $this->client->request('GET', \sprintf('/api/v1/sync/changes?since=%d&limit=2000', $since), server: $this->kim);
        self::assertResponseIsSuccessful();

        /** @var array{cursor: int, smartInboxes: list<array<string, mixed>>, threads: list<array<string, mixed>>, messages: list<array<string, mixed>>} */
        return $this->decodedResponse();
    }

    /**
     * @param array{threads: list<array<string, mixed>>} $page
     *
     * @return array<string, mixed>
     */
    private function threadBySubject(array $page, string $subject): array
    {
        foreach ($page['threads'] as $thread) {
            if ($subject === $thread['subject']) {
                return $thread;
            }
        }
        self::fail('No conversation '.$subject.' in the page.');
    }

    /**
     * @param array{messages: list<array<string, mixed>>} $page
     *
     * @return array<string, mixed>
     */
    private function messageBySubject(array $page, string $subject): array
    {
        foreach ($page['messages'] as $message) {
            if ($subject === $message['subject']) {
                return $message;
            }
        }
        self::fail('No message '.$subject.' in the page.');
    }

    /**
     * @param array{smartInboxes: list<array<string, mixed>>} $page
     *
     * @return array<string, mixed>
     */
    private function smartInbox(array $page, string $builtin): array
    {
        foreach ($page['smartInboxes'] as $smartInbox) {
            if ($builtin === $smartInbox['builtin']) {
                return $smartInbox;
            }
        }
        self::fail('No smart inbox '.$builtin.' in the page.');
    }

    private static function text(mixed $value): string
    {
        self::assertIsString($value);

        return $value;
    }

    private static function number(mixed $value): int
    {
        self::assertIsNumeric($value);

        return (int) $value;
    }
}
