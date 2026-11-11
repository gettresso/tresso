<?php

declare(strict_types=1);

namespace App\Tests\Functional;

use App\Entity\OutgoingMessage;
use App\Outbox\ReleaseOutgoingMessage;
use App\Outbox\ReleaseOutgoingMessageHandler;
use App\Realtime\MercureTokens;
use App\Realtime\RealtimeNotifier;
use App\Storage\BlobVault;
use App\Tests\Support\RecordingMercureHub;
use App\Tests\Support\QueryLog;
use Doctrine\ORM\EntityManagerInterface;
use Lcobucci\JWT\Encoding\JoseEncoder;
use Lcobucci\JWT\Token\Parser;
use Lcobucci\JWT\Token\Plain;
use Symfony\Component\Messenger\Stamp\DelayStamp;
use Symfony\Component\Messenger\Transport\InMemory\InMemoryTransport;
use Symfony\Component\Uid\Uuid;
use Symfony\Component\Uid\UuidV7;

final class OutboxTest extends DatabaseTestCase
{
    use AuthenticatesUsers;
    use StoresMail;

    private string $accountId;

    /** @var array<string, string> */
    private array $kim;

    /** @var array<string, string> */
    private array $worker;

    protected function setUp(): void
    {
        parent::setUp();
        $this->bootstrapOAuthClients();
        $this->createUser('kim@example.test', 'Kim');
        $this->createUser('lisa@example.test', 'Lisa');
        $this->kim = $this->userHeaders('kim@example.test', ['mail:read', 'mail:send', 'settings:write']);

        $this->client->jsonRequest('POST', '/api/v1/mail-accounts', [
            'emailAddress' => 'kim@company.example',
            'displayName' => 'Kim Visser',
            'username' => 'kim@company.example',
            'password' => 'app-password-1',
            'imap' => ['host' => 'imap.company.example', 'port' => 993, 'security' => 'tls'],
            'smtp' => ['host' => 'smtp.company.example', 'port' => 465, 'security' => 'tls'],
        ], $this->kim);
        $this->accountId = $this->responseString('id');

        $this->worker = $this->workerHeaders('sync:lease sync:ingest');
        $this->client->jsonRequest('POST', '/internal/sync/leases', ['workerId' => 'w1'], $this->worker);
        self::assertResponseIsSuccessful();
        $this->hub()->takePublished();
    }

    public function testQueuesAMessageAndTellsTheWorkers(): void
    {
        $sent = $this->send(['to' => [['address' => 'Anna@Finance.example', 'name' => 'Anna de Vries']], 'cc' => [['address' => 'pieter@company.example']], 'bcc' => [['address' => 'archive@company.example']]]);

        self::assertSame('queued', $sent['status']);
        self::assertSame(['to' => [['address' => 'anna@finance.example', 'name' => 'Anna de Vries']], 'cc' => [['address' => 'pieter@company.example', 'name' => null]], 'bcc' => [['address' => 'archive@company.example', 'name' => null]]], $sent['recipients']);

        $published = $this->hub()->takePublished();
        self::assertCount(1, array_filter($published, static fn (array $update): bool => MercureTokens::OUTBOX_TOPIC === $update['body']['topic']));
        $outbox = array_values(array_filter($published, static fn (array $update): bool => MercureTokens::OUTBOX_TOPIC === $update['body']['topic']))[0];
        self::assertSame(json_encode(['mailAccountId' => $this->accountId]), $outbox['body']['data']);
        self::assertSame('on', $outbox['body']['private']);
    }

    public function testBuildsTheMessageWithoutBcc(): void
    {
        $id = $this->send([
            'to' => [['address' => 'anna@finance.example', 'name' => 'Anna de Vries']],
            'bcc' => [['address' => 'archive@company.example']],
            'subject' => 'Q4 budget',
            'html' => '<p>Approved <b>from my side</b>.</p><script>alert(1)</script><p><a href="https://example.test/sheet">The sheet</a></p>',
        ])['id'];
        self::assertIsString($id);

        $raw = $this->raw($id);
        $headers = substr($raw, 0, (int) strpos($raw, "\r\n\r\n"));
        self::assertStringContainsString('From: Kim Visser <kim@company.example>', $headers);
        self::assertStringContainsString('To: Anna de Vries <anna@finance.example>', $headers);
        self::assertStringContainsString('Subject: Q4 budget', $headers);
        self::assertMatchesRegularExpression('/^Message-ID: <[0-9a-f-]{36}@company\.example>\r?$/m', $headers);
        self::assertStringNotContainsStringIgnoringCase('bcc', $raw);
        self::assertStringNotContainsString('archive@company.example', $raw);
        self::assertStringNotContainsString('<script', $raw);
        self::assertStringContainsString('multipart/alternative', $headers);
        self::assertStringContainsString("Approved from my side.\r\n\r\nThe sheet (https://example.test/sheet)", quoted_printable_decode($raw));
    }

    public function testRepliesCarryTheConversationHeaders(): void
    {
        $this->ingestOriginal();
        $originalId = $this->messageIdBySubject('Offsite plan');

        $id = $this->send(['to' => [['address' => 'anna@finance.example']], 'subject' => 'Re: Offsite plan', 'inReplyToMessageId' => $originalId])['id'];
        self::assertIsString($id);

        $raw = $this->raw($id);
        self::assertStringContainsString('In-Reply-To: <plan-2@finance.example>', $raw);
        self::assertMatchesRegularExpression('/References: <plan-1@finance\.example>\s+<plan-2@finance\.example>/', $raw);
    }

    public function testRejectsMessagesWithoutRecipients(): void
    {
        $this->client->jsonRequest('POST', '/api/v1/outgoing-messages', ['mailAccountId' => $this->accountId, 'subject' => 'Hi', 'html' => '<p>Hi</p>'], $this->kim);

        self::assertResponseStatusCodeSame(422);
        self::assertSame('to', $this->violationPaths()[0] ?? null);
    }

    public function testRejectsOtherUsersAccountsAndMessages(): void
    {
        $lisa = $this->userHeaders('lisa@example.test', ['mail:read', 'mail:send']);
        $this->client->jsonRequest('POST', '/api/v1/outgoing-messages', ['mailAccountId' => $this->accountId, 'to' => [['address' => 'x@example.test']]], $lisa);
        self::assertResponseStatusCodeSame(422);
        self::assertSame(['mailAccountId'], $this->violationPaths());

        $this->ingestOriginal();
        $this->client->jsonRequest('POST', '/api/v1/outgoing-messages', ['mailAccountId' => $this->accountId, 'to' => [['address' => 'x@example.test']], 'inReplyToMessageId' => Uuid::v7()->toRfc4122()], $this->kim);
        self::assertResponseStatusCodeSame(422);
        self::assertSame(['inReplyToMessageId'], $this->violationPaths());
    }

    public function testRejectsInvalidRecipientsAndTimes(): void
    {
        $this->client->jsonRequest('POST', '/api/v1/outgoing-messages', ['mailAccountId' => $this->accountId, 'to' => [['address' => 'not an address']]], $this->kim);
        self::assertResponseStatusCodeSame(422);
        self::assertSame(['to[0].address'], $this->violationPaths());

        $this->client->jsonRequest('POST', '/api/v1/outgoing-messages', ['mailAccountId' => $this->accountId, 'to' => [['address' => 'a@example.test']], 'sendAt' => '2020-01-01T00:00:00+00:00'], $this->kim);
        self::assertResponseStatusCodeSame(422);
        self::assertSame(['sendAt'], $this->violationPaths());

        $this->client->jsonRequest('POST', '/api/v1/outgoing-messages', ['mailAccountId' => $this->accountId, 'to' => [['address' => 'a@example.test', 'name' => "Evil\r\nBcc: x@example.test"]]], $this->kim);
        self::assertResponseStatusCodeSame(422);
    }

    public function testSendingAgainWithTheSameIdQueuesTheMessageOnce(): void
    {
        $id = Uuid::v7()->toRfc4122();
        $payload = ['outgoingId' => $id, 'to' => [['address' => 'anna@finance.example']]];

        $first = $this->send($payload);
        // The answer got lost; the client sends the same request again.
        $second = $this->send($payload);

        self::assertSame($id, $first['id'] ?? null);
        self::assertSame($id, $second['id'] ?? null);
        self::assertSame(1, $this->countRows('SELECT COUNT(*) FROM outgoing_message'));
    }

    public function testARetryAfterTheSendTimePassedGetsTheQueuedMessage(): void
    {
        $id = Uuid::v7()->toRfc4122();
        $first = $this->send(['outgoingId' => $id, 'to' => [['address' => 'anna@finance.example']], 'sendAt' => new \DateTimeImmutable('+1 hour')->format(\DATE_ATOM)]);

        // The answer got lost and the retry comes after the send time: it is not refused, the message is on its way.
        $retry = $this->send(['outgoingId' => $id, 'to' => [['address' => 'anna@finance.example']], 'sendAt' => new \DateTimeImmutable('-10 minutes')->format(\DATE_ATOM)]);

        self::assertSame($id, $first['id'] ?? null);
        self::assertSame($id, $retry['id'] ?? null);
        self::assertSame('scheduled', $retry['status'] ?? null);
        self::assertSame(1, $this->countRows('SELECT COUNT(*) FROM outgoing_message'));
    }

    public function testASendStartedDaysAgoStillGoesOutOnce(): void
    {
        // The first request never arrived: the laptop was closed over a weekend.
        $id = new UuidV7(UuidV7::generate(new \DateTimeImmutable('-3 days')))->toRfc4122();
        $payload = ['outgoingId' => $id, 'to' => [['address' => 'anna@finance.example']]];

        $first = $this->send($payload);
        $retry = $this->send($payload);

        self::assertSame($id, $first['id'] ?? null);
        self::assertSame($id, $retry['id'] ?? null);
        self::assertSame(1, $this->countRows('SELECT COUNT(*) FROM outgoing_message'));
    }

    public function testAnIdOfAnotherUsersMessageIsRefused(): void
    {
        $id = $this->sendId(['outgoingId' => Uuid::v7()->toRfc4122(), 'to' => [['address' => 'anna@finance.example']]]);
        $lisa = $this->userHeaders('lisa@example.test', ['mail:send', 'settings:write']);
        $this->client->jsonRequest('POST', '/api/v1/mail-accounts', [
            'emailAddress' => 'lisa@company.example',
            'displayName' => 'Lisa',
            'username' => 'lisa@company.example',
            'password' => 'app-password-1',
            'imap' => ['host' => 'imap.company.example', 'port' => 993, 'security' => 'tls'],
            'smtp' => ['host' => 'smtp.company.example', 'port' => 465, 'security' => 'tls'],
        ], $lisa);
        $lisasAccount = $this->responseString('id');

        $this->client->jsonRequest('POST', '/api/v1/outgoing-messages', ['outgoingId' => $id, 'mailAccountId' => $lisasAccount, 'to' => [['address' => 'bob@example.test']], 'subject' => 'Hello', 'html' => '<p>Hello</p>'], $lisa);

        self::assertResponseStatusCodeSame(409);
        self::assertStringNotContainsString('anna@finance.example', (string) $this->client->getResponse()->getContent());
        self::assertSame(1, $this->countRows('SELECT COUNT(*) FROM outgoing_message'));
        self::assertSame($this->accountId, $this->outgoing($id)->getMailAccount()->getId()->toRfc4122(), 'Kim\'s message is untouched.');
    }

    public function testTwoFirstSendsWithOneIdTakeTurnsOnTheId(): void
    {
        // Two requests at once cannot run in one test process; what makes them safe can be seen: the id is locked
        // before it is looked up again and before anything is stored, so the second waits and then finds the first.
        $id = Uuid::v7()->toRfc4122();
        $log = static::getContainer()->get(QueryLog::class);
        $log->clear();

        $this->sendId(['outgoingId' => $id, 'to' => [['address' => 'anna@finance.example']]]);

        $queries = $log->queries();
        $locked = array_key_first(array_filter($queries, static fn (string $sql): bool => str_contains($sql, 'pg_advisory_xact_lock') && str_contains($sql, 'hashtextextended')));
        $lookups = array_keys(array_filter($queries, static fn (string $sql): bool => (bool) preg_match('/^SELECT .* FROM outgoing_message /s', $sql)));
        $stored = array_key_first(array_filter($queries, static fn (string $sql): bool => str_starts_with($sql, 'INSERT INTO outgoing_message ')));
        self::assertNotNull($locked);
        self::assertNotNull($stored);
        self::assertLessThan($stored, $locked);
        self::assertNotSame([], array_filter($lookups, static fn (int $at): bool => $at < $locked), 'Looked up first, before any check that depends on time.');
        self::assertNotSame([], array_filter($lookups, static fn (int $at): bool => $at > $locked && $at < $stored), 'And again once the id is locked, before it is stored.');
    }

    public function testAClientChosenIdMustBeAUuidV7ThatIsNotAheadOfTheServer(): void
    {
        foreach ([Uuid::v4()->toRfc4122(), new UuidV7(UuidV7::generate(new \DateTimeImmutable('+1 hour')))->toRfc4122()] as $id) {
            $this->client->jsonRequest('POST', '/api/v1/outgoing-messages', ['outgoingId' => $id, 'mailAccountId' => $this->accountId, 'to' => [['address' => 'a@example.test']]], $this->kim);
            self::assertResponseStatusCodeSame(422, $id);
            self::assertSame(['outgoingId'], $this->violationPaths());
        }
        self::assertSame(0, $this->countRows('SELECT COUNT(*) FROM outgoing_message'));
    }

    public function testRequiresSendScope(): void
    {
        $this->client->jsonRequest('POST', '/api/v1/outgoing-messages', ['mailAccountId' => $this->accountId, 'to' => [['address' => 'a@example.test']]], $this->userHeaders('kim@example.test', ['mail:read']));

        self::assertResponseStatusCodeSame(403);
    }

    public function testSchedulesAndCancels(): void
    {
        $sendAt = new \DateTimeImmutable('+1 hour');
        $sent = $this->send(['to' => [['address' => 'anna@finance.example']], 'sendAt' => $sendAt->format(\DATE_ATOM)]);
        self::assertSame('scheduled', $sent['status']);
        self::assertIsString($sent['id']);

        $envelopes = $this->asyncTransport()->getSent();
        self::assertCount(1, $envelopes);
        self::assertInstanceOf(ReleaseOutgoingMessage::class, $envelopes[0]->getMessage());
        $delay = $envelopes[0]->last(DelayStamp::class)?->getDelay();
        self::assertNotNull($delay);
        self::assertEqualsWithDelta(3_600_000, $delay, 5_000);
        self::assertSame([], array_filter($this->hub()->takePublished(), static fn (array $u): bool => MercureTokens::OUTBOX_TOPIC === $u['body']['topic']), 'Workers hear about it only when it is due.');

        $this->client->jsonRequest('POST', '/api/v1/outgoing-messages/'.$sent['id'].'/cancel', [], $this->kim);
        self::assertResponseIsSuccessful();
        self::assertSame('cancelled', $this->decodedResponse()['status'] ?? null);

        $this->client->jsonRequest('POST', '/api/v1/outgoing-messages/'.$sent['id'].'/cancel', [], $this->kim);
        self::assertResponseStatusCodeSame(409);
    }

    public function testASendAtWithAnOffsetIsKeptAsThatMoment(): void
    {
        // Two hours ahead, written as a time in New York: as a wall clock read as UTC it would be due already.
        $sendAt = new \DateTimeImmutable('+2 hours')->setTimezone(new \DateTimeZone('-05:00'));
        $id = $this->sendId(['to' => [['address' => 'anna@finance.example']], 'sendAt' => $sendAt->format(\DATE_ATOM)]);

        self::assertSame($sendAt->getTimestamp(), $this->outgoing($id)->getSendAt()->getTimestamp());
        $this->client->jsonRequest('POST', '/internal/sync/leases', ['workerId' => 'w1'], $this->worker);
        self::assertResponseIsSuccessful();
        self::assertSame('scheduled', $this->outgoingStatus($id), 'The heartbeat leaves it until its time.');
    }

    public function testReleasesAScheduledMessageAtItsTime(): void
    {
        $id = $this->scheduledThatIsDue();

        static::getContainer()->get(ReleaseOutgoingMessageHandler::class)(new ReleaseOutgoingMessage($id));
        static::getContainer()->get(RealtimeNotifier::class)->publish();

        self::assertSame('queued', $this->outgoingStatus($id));
        self::assertNotEmpty(array_filter($this->hub()->takePublished(), static fn (array $u): bool => MercureTokens::OUTBOX_TOPIC === $u['body']['topic']));
    }

    public function testHeartbeatReleasesDueMailAndPointsTheWorkerToIt(): void
    {
        $id = $this->scheduledThatIsDue();

        $this->client->jsonRequest('POST', '/internal/sync/leases', ['workerId' => 'w1'], $this->worker);

        self::assertSame([$this->accountId], $this->decodedResponse()['outbox'] ?? null);
        self::assertSame('queued', $this->outgoingStatus($id));
    }

    public function testWorkerClaimsSendsAndReports(): void
    {
        $id = $this->send(['to' => [['address' => 'anna@finance.example']], 'cc' => [['address' => 'pieter@company.example']], 'bcc' => [['address' => 'Anna@finance.example'], ['address' => 'archive@company.example']]])['id'];
        self::assertIsString($id);

        $claimed = $this->claim();
        self::assertCount(1, $claimed);
        self::assertSame($id, $claimed[0]['id']);
        self::assertSame('kim@company.example', $claimed[0]['envelopeFrom']);
        self::assertSame(['anna@finance.example', 'pieter@company.example', 'archive@company.example'], $claimed[0]['recipients']);
        self::assertSame(1, $claimed[0]['attempt']);
        self::assertFalse($claimed[0]['lastAttempt']);
        self::assertSame('sending', $this->outgoingStatus($id));
        self::assertSame([], $this->claim(), 'A claimed message is not handed out twice.');

        $this->client->jsonRequest('POST', '/api/v1/outgoing-messages/'.$id.'/cancel', [], $this->kim);
        self::assertResponseStatusCodeSame(409, 'Too late to cancel once a worker sends it.');

        $this->report($id, ['outcome' => 'sent']);
        self::assertResponseIsSuccessful();
        self::assertSame('sent', $this->decodedResponse()['status'] ?? null);

        $this->client->request('GET', '/api/v1/sync/changes?since=0', server: $this->kim);
        $outgoing = $this->decodedResponse()['outgoingMessages'] ?? null;
        self::assertIsArray($outgoing);
        self::assertCount(1, $outgoing);
        self::assertIsArray($outgoing[0]);
        self::assertSame('sent', $outgoing[0]['status']);
        self::assertNotNull($outgoing[0]['sentAt']);
        self::assertNull($outgoing[0]['lastError']);
    }

    public function testReportsSentWithoutACopyInSent(): void
    {
        $id = $this->sendId(['to' => [['address' => 'anna@finance.example']]]);
        $this->claim();

        $this->report($id, ['outcome' => 'sent', 'copiedToSent' => false]);

        $this->client->request('GET', '/api/v1/outgoing-messages/'.$id, server: $this->kim);
        self::assertSame('sent', $this->decodedResponse()['status'] ?? null);
        self::assertSame('Sent, but its copy could not be saved in the Sent folder.', $this->decodedResponse()['lastError'] ?? null);
    }

    public function testTemporaryFailuresAreRetriedLater(): void
    {
        $id = $this->sendId(['to' => [['address' => 'anna@finance.example']]]);
        $this->claim();
        $this->asyncTransport()->reset();

        $this->report($id, ['outcome' => 'retry', 'error' => '421 Try again later']);

        self::assertSame('scheduled', $this->decodedResponse()['status'] ?? null);
        $message = $this->outgoing($id);
        self::assertSame('421 Try again later', $message->getLastError());
        self::assertEqualsWithDelta(time() + 60, $message->getSendAt()->getTimestamp(), 5);
        self::assertCount(1, $this->asyncTransport()->getSent(), 'A release is scheduled for the retry.');
    }

    public function testGivesUpAfterTooManyAttempts(): void
    {
        $id = $this->sendId(['to' => [['address' => 'anna@finance.example']]]);
        for ($attempt = 1; $attempt <= OutgoingMessage::MAX_ATTEMPTS; ++$attempt) {
            $this->makeDue($id);
            $claimed = $this->claim();
            self::assertCount(1, $claimed, "Attempt $attempt");
            self::assertSame(OutgoingMessage::MAX_ATTEMPTS === $attempt, $claimed[0]['lastAttempt'], "Attempt $attempt says whether it is the last");
            $this->report($id, ['outcome' => 'retry', 'error' => '451 Local error']);
        }

        self::assertSame('failed', $this->outgoingStatus($id));
    }

    public function testPermanentFailuresStop(): void
    {
        $id = $this->sendId(['to' => [['address' => 'nobody@finance.example']]]);
        $this->claim();

        $this->report($id, ['outcome' => 'failed', 'error' => '550 No such user']);

        self::assertSame('failed', $this->decodedResponse()['status'] ?? null);
        self::assertSame('550 No such user', $this->outgoing($id)->getLastError());
    }

    public function testAnExpiredClaimIsHandedOutAgain(): void
    {
        $id = $this->sendId(['to' => [['address' => 'anna@finance.example']]]);
        $this->claim();
        $this->connection()->executeStatement("UPDATE outgoing_message SET claimed_until = now() - interval '1 minute' WHERE id = :id", ['id' => $id]);

        $claimed = $this->claim();

        self::assertSame(2, $claimed[0]['attempt'] ?? null);
    }

    public function testOnlyTheClaimingWorkerReports(): void
    {
        $id = $this->sendId(['to' => [['address' => 'anna@finance.example']]]);

        $this->report($id, ['outcome' => 'sent']);
        self::assertResponseStatusCodeSame(409, 'Not claimed yet.');

        $this->claim();
        $this->client->jsonRequest('POST', '/internal/sync/accounts/'.$this->accountId.'/outbox/'.$id.'/result', ['workerId' => 'w2', 'outcome' => 'sent'], $this->worker);
        self::assertResponseStatusCodeSame(404, 'w2 holds no lease on the account.');
    }

    public function testWorkersGetATokenForTheOutboxTopic(): void
    {
        $this->client->request('GET', '/internal/sync/realtime-token', server: $this->worker);

        self::assertResponseIsSuccessful();
        self::assertSame($_SERVER['MERCURE_INTERNAL_URL'] ?? null, $this->responseString('hubUrl'));
        $jwt = new Parser(new JoseEncoder())->parse($this->responseString('token') ?: 'x');
        self::assertInstanceOf(Plain::class, $jwt);
        self::assertSame([['type' => MercureTokens::AUTHORIZATION_DETAIL_TYPE, 'actions' => ['subscribe'], 'topics' => [['match' => MercureTokens::OUTBOX_TOPIC, 'match_type' => 'exact']]]], $jwt->claims()->get('authorization_details'));

        $this->client->request('GET', '/internal/sync/realtime-token', server: $this->kim);
        self::assertResponseStatusCodeSame(403);
    }

    /**
     * @param array<string, mixed> $payload
     *
     * @return array<string, mixed>
     */
    private function send(array $payload): array
    {
        $this->client->jsonRequest('POST', '/api/v1/outgoing-messages', $payload + ['mailAccountId' => $this->accountId, 'subject' => 'Hello', 'html' => '<p>Hello</p>'], $this->kim);
        self::assertResponseStatusCodeSame(201);

        /** @var array<string, mixed> */
        return $this->decodedResponse();
    }

    /**
     * @param array<string, mixed> $payload
     */
    private function sendId(array $payload): string
    {
        $id = $this->send($payload)['id'] ?? null;
        self::assertIsString($id);

        return $id;
    }

    /**
     * @return list<array<string, mixed>>
     */
    private function claim(): array
    {
        $this->client->jsonRequest('POST', '/internal/sync/accounts/'.$this->accountId.'/outbox/claim', ['workerId' => 'w1'], $this->worker);
        self::assertResponseIsSuccessful();
        $messages = $this->decodedResponse()['messages'] ?? null;
        self::assertIsArray($messages);

        /** @var list<array<string, mixed>> */
        return $messages;
    }

    /**
     * @param array<string, mixed> $result
     */
    private function report(string $id, array $result): void
    {
        $this->client->jsonRequest('POST', '/internal/sync/accounts/'.$this->accountId.'/outbox/'.$id.'/result', ['workerId' => 'w1'] + $result, $this->worker);
    }

    private function scheduledThatIsDue(): string
    {
        $id = $this->sendId(['to' => [['address' => 'anna@finance.example']], 'sendAt' => new \DateTimeImmutable('+1 hour')->format(\DATE_ATOM)]);
        $this->connection()->executeStatement("UPDATE outgoing_message SET send_at = now() - interval '1 minute' WHERE id = :id", ['id' => $id]);
        static::getContainer()->get(EntityManagerInterface::class)->clear();

        return $id;
    }

    private function makeDue(string $id): void
    {
        $this->connection()->executeStatement("UPDATE outgoing_message SET status = 'queued', send_at = now() - interval '1 minute' WHERE id = :id", ['id' => $id]);
        static::getContainer()->get(EntityManagerInterface::class)->clear();
    }

    private function outgoingStatus(string $id): string
    {
        return $this->outgoing($id)->getStatus()->value;
    }

    private function outgoing(string $id): OutgoingMessage
    {
        $entityManager = static::getContainer()->get(EntityManagerInterface::class);
        $entityManager->clear();
        $message = $entityManager->find(OutgoingMessage::class, Uuid::fromString($id));
        self::assertInstanceOf(OutgoingMessage::class, $message);

        return $message;
    }

    private function raw(string $id): string
    {
        $message = $this->outgoing($id);

        return static::getContainer()->get(BlobVault::class)->read($message->getMailAccount()->getOwner()->getId(), $message->getRawObjectKey());
    }

    /** @return list<string> */
    private function violationPaths(): array
    {
        $violations = $this->decodedResponse()['violations'] ?? [];
        self::assertIsArray($violations);

        return array_values(array_map(static fn (mixed $v): string => \is_array($v) && \is_string($v['propertyPath'] ?? null) ? $v['propertyPath'] : '', $violations));
    }

    private function ingestOriginal(): void
    {
        $this->client->jsonRequest('POST', '/internal/sync/accounts/'.$this->accountId.'/folders', ['workerId' => 'w1', 'folders' => [
            ['remoteName' => 'INBOX', 'displayName' => 'Inbox', 'role' => 'inbox', 'uidValidity' => 1],
        ]], $this->worker);
        self::assertResponseIsSuccessful();
        $this->client->jsonRequest('POST', '/internal/sync/accounts/'.$this->accountId.'/messages', ['workerId' => 'w1', 'folder' => 'INBOX', 'messages' => [[
            'remoteUid' => '1',
            'rawObjectKey' => $this->rawKeyFor($this->accountId, 'plan-2'),
            'keyVersion' => 1,
            'size' => 100,
            'receivedAt' => '2026-10-19T08:00:00+00:00',
            'messageId' => '<plan-2@finance.example>',
            'inReplyTo' => '<plan-1@finance.example>',
            'references' => ['<plan-1@finance.example>'],
            'subject' => 'Offsite plan',
            'from' => ['address' => 'anna@finance.example', 'name' => 'Anna'],
            'to' => [['address' => 'kim@company.example']],
            'snippet' => 'Plan',
        ]]], $this->worker);
        self::assertResponseIsSuccessful();
    }

    private function messageIdBySubject(string $subject): string
    {
        $this->client->request('GET', '/api/v1/sync/changes?since=0', server: $this->kim);
        foreach ((array) ($this->decodedResponse()['messages'] ?? []) as $message) {
            if (\is_array($message) && $message['subject'] === $subject && \is_string($message['id'])) {
                return $message['id'];
            }
        }
        self::fail('No message with subject '.$subject);
    }

    private function hub(): RecordingMercureHub
    {
        return static::getContainer()->get(RecordingMercureHub::class);
    }

    private function asyncTransport(): InMemoryTransport
    {
        $transport = static::getContainer()->get('messenger.transport.async');
        self::assertInstanceOf(InMemoryTransport::class, $transport);

        return $transport;
    }
}
