<?php

declare(strict_types=1);

namespace App\Tests\Functional;

use App\ApiResource\Input\SmartInbox\ThreadClassificationInput;
use App\Classification\ClassificationHandlers;
use App\Classification\ClassifyNewMail;
use App\Classification\MailClassification;
use App\Classification\ReclassifyMail;
use App\Classification\ThreadCorrection;
use App\Entity\Thread;
use App\Entity\User;
use App\Tests\Support\QueryLog;
use Doctrine\DBAL\DriverManager;
use Doctrine\ORM\EntityManagerInterface;
use Symfony\Bundle\FrameworkBundle\Console\Application;
use Symfony\Component\Console\Tester\CommandTester;
use Symfony\Component\Messenger\Envelope;
use Symfony\Component\Messenger\MessageBusInterface;
use Symfony\Component\Messenger\Stamp\ReceivedStamp;
use Symfony\Component\Messenger\Transport\InMemory\InMemoryTransport;
use Symfony\Component\Uid\Uuid;

/**
 * Classification of ingested mail end to end: queued after the ingest commits, run the way the messenger worker runs
 * it, and seen by clients through the delta.
 */
final class ClassificationTest extends DatabaseTestCase
{
    use AuthenticatesUsers;
    use StoresMail;

    private const string ME = 'kim@company.example';

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

        $this->worker = $this->workerHeaders('sync:lease sync:ingest');
        $this->client->jsonRequest('POST', '/internal/sync/leases', ['workerId' => 'w1'], $this->worker);
        $this->ingest('folders', ['folders' => [
            ['remoteName' => 'INBOX', 'displayName' => 'Inbox', 'role' => 'inbox', 'uidValidity' => 1],
            ['remoteName' => 'Junk', 'displayName' => 'Junk', 'role' => 'spam', 'uidValidity' => 1],
            ['remoteName' => 'Sent', 'displayName' => 'Sent', 'role' => 'sent', 'uidValidity' => 1],
        ]]);
    }

    public function testIngestQueuesClassificationAfterTheCommit(): void
    {
        $this->ingest('messages', ['folder' => 'INBOX', 'messages' => [$this->message('1', 'Budget'), $this->message('2', 'Offsite')]]);

        $queued = $this->classifyTransport()->getSent();
        self::assertCount(1, $queued, 'Queued once per transaction.');
        self::assertInstanceOf(ClassifyNewMail::class, $queued[0]->getMessage());
    }

    public function testNewMailGetsASmartInboxAndVerdictPerMessageAndConversation(): void
    {
        $this->ingest('messages', ['folder' => 'INBOX', 'messages' => [
            $this->message('1', 'Budget'),
            $this->message('2', 'Weekly deals', ['from' => ['address' => 'newsletter@shop.example'], 'headers' => ['list-unsubscribe' => '<https://shop.example/u>']]),
            $this->message('3', 'Build failed', ['from' => ['address' => 'ci@forge.example'], 'headers' => ['auto-submitted' => 'auto-generated']]),
        ]]);
        $this->ingest('messages', ['folder' => 'Junk', 'messages' => [$this->message('1', 'You won', ['from' => ['address' => 'prize@lottery.example']])]]);
        $this->runClassification();

        $page = $this->changes(0);
        $inboxes = $this->builtinIds($page);
        $threads = array_column($page['threads'], null, 'subject');
        self::assertSame([$inboxes['todo'], 'do', 'direct'], $this->classificationOf($threads['Budget']));
        self::assertSame([$inboxes['advertise'], 'know', 'marketing_sender'], $this->classificationOf($threads['Weekly deals']));
        self::assertSame([$inboxes['notification'], 'know', 'automated'], $this->classificationOf($threads['Build failed']));
        self::assertSame([$inboxes['spam'], 'none', 'server_spam'], $this->classificationOf($threads['You won']));

        $messages = array_column($page['messages'], null, 'subject');
        self::assertSame($inboxes['todo'], $messages['Budget']['smartInboxId']);
        self::assertSame('do', $messages['Budget']['verdict']);
    }

    public function testTheUsersOwnMailIsNotClassified(): void
    {
        $this->ingest('messages', ['folder' => 'INBOX', 'messages' => [$this->message('1', 'Budget', ['messageId' => '<budget@x>'])]]);
        $this->ingest('messages', ['folder' => 'Sent', 'messages' => [
            $this->message('1', 'Re: Budget', ['messageId' => '<reply@x>', 'inReplyTo' => '<budget@x>', 'from' => ['address' => self::ME], 'to' => [['address' => 'anna@partner.example']], 'receivedAt' => self::receivedAt(9)]),
            $this->message('2', 'Lunch?', ['messageId' => '<lunch@x>', 'from' => ['address' => self::ME], 'to' => [['address' => 'anna@partner.example']]]),
        ]]);
        $this->runClassification();

        $page = $this->changes(0);
        $inboxes = $this->builtinIds($page);
        $threads = array_column($page['threads'], null, 'subject');
        self::assertSame([$inboxes['todo'], 'do', 'direct'], $this->classificationOf($threads['Budget']), 'The conversation follows its newest incoming message.');
        self::assertSame([null, null, null], $this->classificationOf($threads['Lunch?']));
        $messages = array_column($page['messages'], null, 'subject');
        self::assertNull($messages['Re: Budget']['verdict']);
        self::assertEquals(0, $this->connection()->fetchOne('SELECT COUNT(*) FROM message WHERE classified_at IS NULL'), 'Every message was looked at.');
    }

    public function testCorrectionMovesTheConversationAndIsRememberedForTheSender(): void
    {
        $this->ingest('messages', ['folder' => 'INBOX', 'messages' => [
            $this->message('1', 'Invoice October', ['from' => ['address' => 'billing@hosting.example']]),
            $this->message('2', 'Invoice September', ['from' => ['address' => 'billing@hosting.example']]),
        ]]);
        $this->runClassification();
        $first = $this->changes(0);
        $inboxes = $this->builtinIds($first);
        $threads = array_column($first['threads'], 'id', 'subject');

        $this->client->jsonRequest('PUT', '/api/v1/threads/'.$threads['Invoice October'].'/classification', ['smartInboxId' => $inboxes['notification'], 'verdict' => 'do'], $this->kim);

        self::assertResponseIsSuccessful();
        $body = $this->decodedResponse();
        self::assertSame('user', $body['reason'] ?? null);
        self::assertSame('do', $body['verdict'] ?? null);
        self::assertIsArray($body['senderRule'] ?? null);
        self::assertSame('billing@hosting.example', $body['senderRule']['sender'] ?? null);
        $this->runClassification();

        $page = array_column($this->changes($first['cursor'])['threads'], null, 'subject');
        self::assertSame([$inboxes['notification'], 'do', 'user'], $this->classificationOf($page['Invoice October']));
        self::assertSame([$inboxes['notification'], 'do', 'sender_rule'], $this->classificationOf($page['Invoice September']), 'Recent mail from the sender moves too.');

        $this->ingest('messages', ['folder' => 'INBOX', 'messages' => [$this->message('3', 'Invoice November', ['from' => ['address' => 'billing@hosting.example']])]]);
        $this->runClassification();
        $next = array_column($this->changes(0)['threads'], null, 'subject');
        self::assertSame([$inboxes['notification'], 'do', 'sender_rule'], $this->classificationOf($next['Invoice November']));
    }

    public function testCorrectedConversationsStayWhereTheUserPutThem(): void
    {
        $this->ingest('messages', ['folder' => 'INBOX', 'messages' => [$this->message('1', 'Budget')]]);
        $this->runClassification();
        $first = $this->changes(0);
        $inboxes = $this->builtinIds($first);
        $threadId = $first['threads'][0]['id'];
        $this->client->jsonRequest('PUT', '/api/v1/threads/'.$threadId.'/classification', ['smartInboxId' => $inboxes['informational']], $this->kim);
        self::assertResponseIsSuccessful();
        $this->runClassification();

        // A broad include list elsewhere does not take the conversation away.
        $this->client->request('PATCH', '/api/v1/smart-inboxes/'.$inboxes['todo'], server: $this->kim + ['CONTENT_TYPE' => 'application/merge-patch+json'], content: '{"includeSenders":["@partner.example"]}');
        self::assertResponseIsSuccessful();
        $this->runClassification();

        $thread = $this->changes(0)['threads'][0];
        self::assertSame([$inboxes['informational'], 'know', 'user'], $this->classificationOf($thread));
    }

    public function testACorrectionThatIsNotRememberedMovesOnlyThatConversation(): void
    {
        $this->ingest('messages', ['folder' => 'INBOX', 'messages' => [
            $this->message('1', 'Invoice October', ['from' => ['address' => 'billing@hosting.example']]),
            $this->message('2', 'Invoice September', ['from' => ['address' => 'billing@hosting.example']]),
        ]]);
        $this->runClassification();
        $first = $this->changes(0);
        $inboxes = $this->builtinIds($first);
        $threads = array_column($first['threads'], 'id', 'subject');
        $this->client->request('PATCH', '/api/v1/smart-inboxes/'.$inboxes['informational'], server: $this->kim + ['CONTENT_TYPE' => 'application/merge-patch+json'], content: '{"excludeSenders":["billing@hosting.example"]}');
        self::assertResponseIsSuccessful();
        $this->runClassification();

        $this->client->jsonRequest('PUT', '/api/v1/threads/'.$threads['Invoice October'].'/classification', ['smartInboxId' => $inboxes['informational'], 'verdict' => 'delegate', 'remember' => false], $this->kim);

        self::assertResponseIsSuccessful();
        $body = $this->decodedResponse();
        self::assertArrayHasKey('senderRule', $body);
        self::assertNull($body['senderRule']);
        $this->runClassification();
        $page = array_column($this->changes(0)['threads'], null, 'subject');
        self::assertSame([$inboxes['informational'], 'delegate', 'user'], $this->classificationOf($page['Invoice October']));
        self::assertSame([$inboxes['todo'], 'do', 'direct'], $this->classificationOf($page['Invoice September']), 'Other mail from the sender stays.');
        $this->client->request('GET', '/api/v1/sender-rules', server: $this->kim);
        self::assertSame([], $this->decodedResponse());
        $this->client->request('GET', '/api/v1/smart-inboxes/'.$inboxes['informational'], server: $this->kim);
        self::assertSame(['billing@hosting.example'], $this->decodedResponse()['excludeSenders'] ?? null, 'The exclude list stays.');
    }

    public function testTakingACorrectionBackLetsTheRulesPlaceTheConversationAgain(): void
    {
        $this->ingest('messages', ['folder' => 'INBOX', 'messages' => [$this->message('1', 'Budget')]]);
        $this->runClassification();
        $first = $this->changes(0);
        $inboxes = $this->builtinIds($first);
        $threadId = $first['threads'][0]['id'];
        $placementId = $this->place($threadId, ['smartInboxId' => $inboxes['informational'], 'remember' => false]);
        $placed = $this->changes(0)['cursor'];

        $this->client->request('DELETE', $this->releaseUrl($threadId, $placementId), server: $this->userHeaders('kim@example.test', ['mail:read', 'mail:write']));

        self::assertResponseStatusCodeSame(204);
        $page = $this->changes($placed);
        self::assertSame([$inboxes['todo'], 'do', 'direct'], $this->classificationOf($page['threads'][0]), 'Clients see it move back.');
        self::assertSame([$inboxes['todo'], 'do'], [$page['messages'][0]['smartInboxId'], $page['messages'][0]['verdict']]);
    }

    public function testTakingACorrectionBackKeepsTheSenderRule(): void
    {
        $this->ingest('messages', ['folder' => 'INBOX', 'messages' => [$this->message('1', 'Budget')]]);
        $this->runClassification();
        $first = $this->changes(0);
        $inboxes = $this->builtinIds($first);
        $threadId = $first['threads'][0]['id'];
        $placementId = $this->place($threadId, ['smartInboxId' => $inboxes['informational']]);
        $this->runClassification();

        $this->client->request('DELETE', $this->releaseUrl($threadId, $placementId), server: $this->kim);

        self::assertResponseStatusCodeSame(204);
        self::assertSame([$inboxes['informational'], 'know', 'sender_rule'], $this->classificationOf($this->changes(0)['threads'][0]));
        $this->client->request('GET', '/api/v1/sender-rules', server: $this->kim);
        self::assertCount(1, $this->decodedResponse());
    }

    public function testTakingBackLeavesAConversationTheUserDidNotPlaceAlone(): void
    {
        $this->ingest('messages', ['folder' => 'INBOX', 'messages' => [$this->message('1', 'Budget')]]);
        $this->runClassification();
        $first = $this->changes(0);

        $this->client->request('DELETE', $this->releaseUrl($first['threads'][0]['id'], Uuid::v7()->toRfc4122()), server: $this->kim);

        self::assertResponseStatusCodeSame(204);
        self::assertSame([], $this->changes($first['cursor'])['threads'], 'Nothing changed.');
    }

    public function testTakingBackAConversationOfOnlyTheUsersOwnMailTakesItOutOfTheSmartInbox(): void
    {
        $this->ingest('messages', ['folder' => 'Sent', 'messages' => [$this->message('1', 'Lunch?', ['from' => ['address' => self::ME], 'to' => [['address' => 'anna@partner.example']]])]]);
        $this->runClassification();
        $first = $this->changes(0);
        $threadId = $first['threads'][0]['id'];
        $placementId = $this->place($threadId, ['smartInboxId' => $this->builtinIds($first)['todo'], 'remember' => false]);

        $this->client->request('DELETE', $this->releaseUrl($threadId, $placementId), server: $this->kim);

        self::assertResponseStatusCodeSame(204);
        self::assertSame([null, null, null], $this->classificationOf($this->changes(0)['threads'][0]));
    }

    public function testTakingBackLeavesALaterChoiceAlone(): void
    {
        $this->ingest('messages', ['folder' => 'INBOX', 'messages' => [$this->message('1', 'Budget')]]);
        $this->runClassification();
        $first = $this->changes(0);
        $inboxes = $this->builtinIds($first);
        $threadId = $first['threads'][0]['id'];
        $placementId = $this->place($threadId, ['smartInboxId' => $inboxes['todo'], 'verdict' => 'do', 'remember' => false]);
        // Another device moves it again before the undo of the first choice arrives.
        $this->place($threadId, ['smartInboxId' => $inboxes['informational'], 'remember' => false]);

        $this->client->request('DELETE', $this->releaseUrl($threadId, $placementId), server: $this->kim);

        self::assertResponseStatusCodeSame(409);
        self::assertSame([$inboxes['informational'], 'know', 'user'], $this->classificationOf($this->changes(0)['threads'][0]));
    }

    public function testTakingBackLeavesALaterIdenticalChoiceAlone(): void
    {
        $this->ingest('messages', ['folder' => 'INBOX', 'messages' => [$this->message('1', 'Budget')]]);
        $this->runClassification();
        $first = $this->changes(0);
        $inboxes = $this->builtinIds($first);
        $threadId = $first['threads'][0]['id'];
        $placement = ['smartInboxId' => $inboxes['todo'], 'verdict' => 'delegate', 'remember' => false];
        $placementId = $this->place($threadId, $placement);
        // Another device makes the same choice: it is a choice of its own, and stays.
        $later = $this->place($threadId, $placement);
        self::assertNotSame($placementId, $later);

        $this->client->request('DELETE', $this->releaseUrl($threadId, $placementId), server: $this->kim);

        self::assertResponseStatusCodeSame(409);
        self::assertSame([$inboxes['todo'], 'delegate', 'user'], $this->classificationOf($this->changes(0)['threads'][0]));
    }

    public function testTakingBackNamesThePlacement(): void
    {
        $this->ingest('messages', ['folder' => 'INBOX', 'messages' => [$this->message('1', 'Budget')]]);
        $this->runClassification();
        $first = $this->changes(0);
        $threadId = $first['threads'][0]['id'];

        $this->client->request('DELETE', '/api/v1/threads/'.$threadId.'/classification', server: $this->kim);
        self::assertResponseStatusCodeSame(400);
        $this->client->request('DELETE', $this->releaseUrl($threadId, 'not-an-id'), server: $this->kim);
        self::assertResponseStatusCodeSame(400);
    }

    public function testOnlyTheOwnerCanTakeACorrectionBack(): void
    {
        $this->ingest('messages', ['folder' => 'INBOX', 'messages' => [$this->message('1', 'Budget')]]);
        $this->runClassification();
        $first = $this->changes(0);
        $inboxes = $this->builtinIds($first);
        $threadId = $first['threads'][0]['id'];
        $placementId = $this->place($threadId, ['smartInboxId' => $inboxes['informational'], 'remember' => false]);

        $this->client->request('DELETE', $this->releaseUrl($threadId, $placementId), server: $this->userHeaders('lisa@example.test', ['mail:read', 'mail:write']));
        self::assertResponseStatusCodeSame(404);
        $this->client->request('DELETE', $this->releaseUrl($threadId, $placementId), server: $this->userHeaders('kim@example.test', ['mail:read']));
        self::assertResponseStatusCodeSame(403);

        self::assertSame([$inboxes['informational'], 'know', 'user'], $this->classificationOf($this->changes(0)['threads'][0]));
    }

    public function testCorrectionTakesTheSenderOffTheExcludeList(): void
    {
        $this->ingest('messages', ['folder' => 'INBOX', 'messages' => [$this->message('1', 'Budget')]]);
        $this->runClassification();
        $first = $this->changes(0);
        $inboxes = $this->builtinIds($first);
        $this->client->request('PATCH', '/api/v1/smart-inboxes/'.$inboxes['informational'], server: $this->kim + ['CONTENT_TYPE' => 'application/merge-patch+json'], content: '{"excludeSenders":["anna@partner.example","@other.example"]}');
        self::assertResponseIsSuccessful();

        $this->client->jsonRequest('PUT', '/api/v1/threads/'.$first['threads'][0]['id'].'/classification', ['smartInboxId' => $inboxes['informational']], $this->kim);
        self::assertResponseIsSuccessful();

        $this->client->request('GET', '/api/v1/smart-inboxes/'.$inboxes['informational'], server: $this->kim);
        self::assertSame(['@other.example'], $this->decodedResponse()['excludeSenders'] ?? null);
    }

    public function testDeletingASmartInboxReleasesItsConversations(): void
    {
        $this->client->jsonRequest('POST', '/api/v1/smart-inboxes', ['name' => 'Partners', 'includeSenders' => ['@partner.example'], 'verdict' => 'delegate'], $this->kim);
        $partners = $this->responseString('id');
        $this->ingest('messages', ['folder' => 'INBOX', 'messages' => [$this->message('1', 'Budget')]]);
        $this->runClassification();
        $first = $this->changes(0);
        self::assertSame([$partners, 'delegate', 'include_list'], $this->classificationOf($first['threads'][0]));

        $this->client->request('DELETE', '/api/v1/smart-inboxes/'.$partners, server: $this->kim);
        self::assertResponseStatusCodeSame(204);
        $queued = $this->takeQueued();
        $released = $this->changes($first['cursor']);
        self::assertContains(['type' => 'smartInbox', 'id' => $partners], $released['deleted']);
        self::assertSame([null, null, null], $this->classificationOf($released['threads'][0]), 'Clients see the conversation leave.');
        self::assertNull($released['messages'][0]['smartInboxId']);

        $this->runClassification($queued);
        $inboxes = $this->builtinIds($first);
        self::assertSame([$inboxes['todo'], 'do', 'direct'], $this->classificationOf($this->changes($released['cursor'])['threads'][0]));
    }

    public function testSenderRulesCanBeListedAndForgotten(): void
    {
        $this->ingest('messages', ['folder' => 'INBOX', 'messages' => [$this->message('1', 'Budget'), $this->message('2', 'Budget again', ['messageId' => '<again@x>'])]]);
        $this->runClassification();
        $first = $this->changes(0);
        $inboxes = $this->builtinIds($first);
        $threads = array_column($first['threads'], 'id', 'subject');
        $this->client->jsonRequest('PUT', '/api/v1/threads/'.$threads['Budget'].'/classification', ['smartInboxId' => $inboxes['informational']], $this->kim);
        $this->runClassification();

        $this->client->request('GET', '/api/v1/sender-rules', server: $this->kim);
        /** @var list<array{id: string, sender: string, smartInboxId: string, verdict: ?string, updatedAt: string}> $rules */
        $rules = $this->decodedResponse();
        self::assertCount(1, $rules);
        self::assertSame('anna@partner.example', $rules[0]['sender']);
        self::assertSame($inboxes['informational'], $rules[0]['smartInboxId']);
        self::assertNull($rules[0]['verdict']);

        $this->client->request('DELETE', '/api/v1/sender-rules/'.$rules[0]['id'], server: $this->kim);
        self::assertResponseStatusCodeSame(204);
        $this->runClassification();

        $threads = array_column($this->changes(0)['threads'], null, 'subject');
        self::assertSame('direct', $threads['Budget again']['classificationReason'], 'Without the rule, the rules decide again.');
        self::assertSame('user', $threads['Budget']['classificationReason']);
    }

    public function testCorrectionsStayWithinTheUsersOwnData(): void
    {
        $this->ingest('messages', ['folder' => 'INBOX', 'messages' => [$this->message('1', 'Budget')]]);
        $this->runClassification();
        $page = $this->changes(0);
        $threadId = $page['threads'][0]['id'];
        $inboxes = $this->builtinIds($page);

        $lisa = $this->userHeaders('lisa@example.test', ['mail:write', 'settings:read', 'settings:write']);
        $this->client->jsonRequest('PUT', '/api/v1/threads/'.$threadId.'/classification', ['smartInboxId' => $inboxes['spam']], $lisa);
        self::assertResponseStatusCodeSame(404);

        $this->client->request('GET', '/api/v1/smart-inboxes', server: $lisa);
        $lisasTodo = array_column($this->decodedResponse(), 'id', 'builtin')['todo'];
        $this->client->jsonRequest('PUT', '/api/v1/threads/'.$threadId.'/classification', ['smartInboxId' => $lisasTodo], $this->kim);
        self::assertResponseStatusCodeSame(422);
    }

    public function testSmartInboxesFromBeforeTheSyncReachASyncFromTheStart(): void
    {
        $this->connection()->executeStatement("UPDATE category SET change_seq = 0 FROM app_user u WHERE u.id = category.owner_id AND u.email = 'kim@example.test'");

        $page = $this->changes(0);

        self::assertCount(5, $page['smartInboxes']);
        self::assertSame([], $this->changes($page['cursor'])['smartInboxes'], 'Only once.');
    }

    public function testRuleChangesDoNotResendMailWhoseClassificationStays(): void
    {
        $this->ingest('messages', ['folder' => 'INBOX', 'messages' => [$this->message('1', 'Budget'), $this->message('2', 'Deals', ['from' => ['address' => 'newsletter@shop.example']])]]);
        $this->runClassification();
        $first = $this->changes(0);
        $inboxes = $this->builtinIds($first);

        $this->client->request('PATCH', '/api/v1/smart-inboxes/'.$inboxes['informational'], server: $this->kim + ['CONTENT_TYPE' => 'application/merge-patch+json'], content: '{"instructions":"For my information"}');
        self::assertResponseIsSuccessful();
        $this->runClassification();

        $page = $this->changes($first['cursor']);
        self::assertSame([$inboxes['informational']], array_column($page['smartInboxes'], 'id'));
        self::assertSame([], $page['threads']);
        self::assertSame([], $page['messages']);
    }

    public function testCorrectionClassifiesAgainOnlyMailFromThatSender(): void
    {
        $this->ingest('messages', ['folder' => 'INBOX', 'messages' => [
            $this->message('1', 'Invoice', ['from' => ['address' => 'billing@hosting.example']]),
            $this->message('2', 'Budget'),
            $this->message('3', 'Invoice again', ['from' => ['address' => 'billing@hosting.example']]),
        ]]);
        $this->runClassification();
        $first = $this->changes(0);
        $inboxes = $this->builtinIds($first);
        $threads = array_column($first['threads'], 'id', 'subject');

        $this->client->jsonRequest('PUT', '/api/v1/threads/'.$threads['Invoice'].'/classification', ['smartInboxId' => $inboxes['notification']], $this->kim);
        self::assertResponseIsSuccessful();

        $envelopes = $this->takeQueued();
        $queued = array_map(static fn (Envelope $envelope): object => $envelope->getMessage(), $envelopes);
        self::assertCount(1, $queued);
        self::assertInstanceOf(ReclassifyMail::class, $queued[0]);
        self::assertSame('billing@hosting.example', $queued[0]->sender);
        self::assertNotNull($queued[0]->since);

        // Misplace every other conversation: a run over all mail would put them back, a run for the sender leaves them.
        $this->connection()->executeStatement('UPDATE thread SET category_id = :spam, verdict = :none WHERE id IN (:budget, :again)', ['spam' => $inboxes['spam'], 'none' => 'none', 'budget' => $threads['Budget'], 'again' => $threads['Invoice again']]);
        $this->runClassification($envelopes);

        $after = array_column($this->changes(0)['threads'], null, 'subject');
        self::assertSame([$inboxes['spam'], 'none'], [$after['Budget']['smartInboxId'], $after['Budget']['verdict']], 'Another sender is left alone.');
        self::assertSame([$inboxes['notification'], 'know', 'sender_rule'], $this->classificationOf($after['Invoice again']));
    }

    public function testRerunForADomainCoversItsSubdomainsAndNoOtherSender(): void
    {
        $this->ingest('messages', ['folder' => 'INBOX', 'messages' => [
            $this->message('1', 'Invoice', ['from' => ['address' => 'billing@hosting.example']]),
            $this->message('2', 'Status', ['from' => ['address' => 'ops@eu.hosting.example']]),
            $this->message('3', 'Look-alike', ['from' => ['address' => 'billing@myhosting.example']]),
            $this->message('4', 'Budget'),
        ]]);
        $this->runClassification();
        $first = $this->changes(0);
        $inboxes = $this->builtinIds($first);
        $this->connection()->executeStatement('UPDATE thread SET category_id = :spam, verdict = :none', ['spam' => $inboxes['spam'], 'none' => 'none']);

        static::getContainer()->get(MailClassification::class)->reclassify($this->kimsId(), null, '@hosting.example');

        $after = array_column($this->connection()->fetchAllAssociative('SELECT t.subject, t.category_id FROM thread t'), 'category_id', 'subject');
        self::assertSame($inboxes['todo'], $after['Invoice']);
        self::assertSame($inboxes['todo'], $after['Status']);
        self::assertSame($inboxes['spam'], $after['Look-alike']);
        self::assertSame($inboxes['spam'], $after['Budget']);
    }

    public function testCorrectionReadsTheConversationAgainAfterTakingTheLocks(): void
    {
        $this->ingest('messages', ['folder' => 'INBOX', 'messages' => [$this->message('1', 'Budget')]]);
        $this->runClassification();
        $first = $this->changes(0);
        $inboxes = $this->builtinIds($first);
        $threadId = $first['threads'][0]['id'];
        $entityManager = static::getContainer()->get(EntityManagerInterface::class);

        // The request's copy says Informational, from before a classification run committed To do.
        $this->connection()->executeStatement("UPDATE thread SET category_id = :info, verdict = 'know', classification_reason = 'copied' WHERE id = :id", ['info' => $inboxes['informational'], 'id' => $threadId]);
        $entityManager->clear();
        $owner = $entityManager->find(User::class, $this->kimsId());
        self::assertInstanceOf(User::class, $owner);
        self::assertNotNull($entityManager->find(Thread::class, Uuid::fromString($threadId)));
        $this->connection()->executeStatement("UPDATE thread SET category_id = :todo, verdict = 'do', classification_reason = 'direct' WHERE id = :id", ['todo' => $inboxes['todo'], 'id' => $threadId]);

        $input = new ThreadClassificationInput();
        $input->smartInboxId = $inboxes['informational'];
        static::getContainer()->get(ThreadCorrection::class)->correct($owner, $threadId, $input);

        self::assertSame(
            ['category_id' => $inboxes['informational'], 'verdict' => 'know', 'classification_reason' => 'user'],
            $this->connection()->fetchAssociative('SELECT category_id, verdict, classification_reason FROM thread WHERE id = :id', ['id' => $threadId]),
        );
    }

    public function testAStoppedJobQueuesTheRest(): void
    {
        foreach ([1, 2] as $part) {
            $this->ingest('messages', ['folder' => 'INBOX', 'messages' => array_map(fn (int $i): array => $this->message($part.'-'.$i, 'Mail '.$part.'-'.$i), range(1, 101))]);
        }
        $this->takeQueued();
        $container = static::getContainer();
        $handlers = new ClassificationHandlers($container->get(MailClassification::class), $container->get(MessageBusInterface::class), 1);

        $handlers->classifyNew(new ClassifyNewMail($this->kimsId()->toRfc4122()));
        $queued = array_map(static fn (Envelope $envelope): object => $envelope->getMessage(), $this->takeQueued());
        self::assertEquals([new ClassifyNewMail($this->kimsId()->toRfc4122())], $queued);

        $handlers->classifyNew(new ClassifyNewMail($this->kimsId()->toRfc4122()));
        self::assertSame([], $this->takeQueued(), 'Done: nothing more is queued.');

        $handlers->reclassify(new ReclassifyMail($this->kimsId()->toRfc4122(), null));
        $rest = array_map(static fn (Envelope $envelope): object => $envelope->getMessage(), $this->takeQueued());
        self::assertCount(1, $rest);
        self::assertInstanceOf(ReclassifyMail::class, $rest[0]);
        self::assertNotNull($rest[0]->after);
    }

    public function testMailFiledAsSentInGmailStyleFoldersIsTheUsersOwn(): void
    {
        $this->ingest('folders', ['folders' => [
            ['remoteName' => 'INBOX', 'displayName' => 'Inbox', 'role' => 'inbox', 'uidValidity' => 1],
            ['remoteName' => '[Gmail]/Sent Mail', 'displayName' => 'Sent Mail', 'role' => 'sent', 'uidValidity' => 1],
            ['remoteName' => '[Gmail]/All Mail', 'displayName' => 'All Mail', 'role' => 'all', 'uidValidity' => 1],
        ]]);
        $alias = $this->message('1', 'From my alias', ['messageId' => '<alias@x>', 'from' => ['address' => 'kim@alias.example'], 'to' => [['address' => 'anna@partner.example']]]);
        $this->ingest('messages', ['folder' => '[Gmail]/Sent Mail', 'messages' => [$alias]]);
        $this->ingest('messages', ['folder' => '[Gmail]/All Mail', 'messages' => [$alias, $this->message('2', 'Archived question', ['messageId' => '<archived@x>'])]]);
        $this->runClassification();

        $threads = array_column($this->changes(0)['threads'], null, 'subject');
        self::assertSame([null, null, null], $this->classificationOf($threads['From my alias']));
        self::assertSame('direct', $threads['Archived question']['classificationReason'], 'Mail only in All Mail is still classified.');
    }

    public function testCorrectionIntoASmartInboxThatExcludesTheSendersDomainIsRefused(): void
    {
        $this->ingest('messages', ['folder' => 'INBOX', 'messages' => [$this->message('1', 'Budget')]]);
        $this->runClassification();
        $first = $this->changes(0);
        $inboxes = $this->builtinIds($first);
        $this->client->request('PATCH', '/api/v1/smart-inboxes/'.$inboxes['informational'], server: $this->kim + ['CONTENT_TYPE' => 'application/merge-patch+json'], content: '{"excludeSenders":["@partner.example"]}');
        self::assertResponseIsSuccessful();

        $this->client->jsonRequest('PUT', '/api/v1/threads/'.$first['threads'][0]['id'].'/classification', ['smartInboxId' => $inboxes['informational']], $this->kim);

        self::assertResponseStatusCodeSame(422);
        self::assertStringContainsString('@partner.example', (string) $this->client->getResponse()->getContent());
        $this->client->request('GET', '/api/v1/sender-rules', server: $this->kim);
        self::assertSame([], $this->decodedResponse());
        self::assertSame([$inboxes['todo'], 'do', 'direct'], $this->classificationOf($this->changes(0)['threads'][0]));
    }

    public function testCorrectionWaitsForARunningClassificationOfTheUser(): void
    {
        // Not classified first: in a test everything runs in one transaction, which would keep the lock of that run.
        $this->ingest('messages', ['folder' => 'INBOX', 'messages' => [$this->message('1', 'Budget')]]);
        $first = $this->changes(0);
        $userId = $this->connection()->fetchOne("SELECT id FROM app_user WHERE email = 'kim@example.test'");
        self::assertIsString($userId);

        $running = DriverManager::getConnection($this->separateConnectionParams());
        $running->executeStatement('SELECT pg_advisory_lock(hashtextextended(:key, 0))', ['key' => 'classify:'.$userId]);
        $this->connection()->executeStatement("SET lock_timeout = '300ms'");
        try {
            $this->client->jsonRequest('PUT', '/api/v1/threads/'.$first['threads'][0]['id'].'/classification', ['smartInboxId' => $this->builtinIds($first)['informational']], $this->kim);

            self::assertResponseStatusCodeSame(500);
            self::assertStringContainsString('55P03', (string) $this->client->getResponse()->getContent(), 'The correction waited for the lock of the running classification until lock_timeout.');
        } finally {
            $this->connection()->executeStatement('RESET lock_timeout');
            $running->executeStatement('SELECT pg_advisory_unlock_all()');
            $running->close();
        }
    }

    public function testCorrectionWaitsForAnotherDevicesSmartInboxEdit(): void
    {
        $this->ingest('messages', ['folder' => 'INBOX', 'messages' => [$this->message('1', 'Budget')]]);
        $first = $this->changes(0);

        $editing = DriverManager::getConnection($this->separateConnectionParams());
        $editing->executeStatement('SELECT pg_advisory_lock(hashtextextended(:key, 0))', ['key' => 'smart-inboxes:'.$this->kimsId()->toRfc4122()]);
        $this->connection()->executeStatement("SET lock_timeout = '300ms'");
        try {
            $this->client->jsonRequest('PUT', '/api/v1/threads/'.$first['threads'][0]['id'].'/classification', ['smartInboxId' => $this->builtinIds($first)['informational']], $this->kim);

            self::assertResponseStatusCodeSame(500);
            self::assertStringContainsString('55P03', (string) $this->client->getResponse()->getContent(), 'The correction waited for the smart inbox edit, so its exclude list change cannot be lost.');
        } finally {
            $this->connection()->executeStatement('RESET lock_timeout');
            $editing->executeStatement('SELECT pg_advisory_unlock_all()');
            $editing->close();
        }
    }

    public function testAGenericImapServersAuthenticationResultsNeverRescueSpam(): void
    {
        $this->ingest('messages', ['folder' => 'INBOX', 'messages' => [$this->message('1', 'Invoice', ['from' => ['address' => 'billing@supplier.example']])]]);
        $this->runClassification();
        $first = $this->changes(0);
        $inboxes = $this->builtinIds($first);
        $this->client->jsonRequest('PUT', '/api/v1/threads/'.$first['threads'][0]['id'].'/classification', ['smartInboxId' => $inboxes['todo']], $this->kim);
        self::assertResponseIsSuccessful();
        $this->runClassification();

        // The sender wrote the header itself, naming the recipient's own server: this IMAP server adds none of its own.
        $this->ingest('messages', ['folder' => 'Junk', 'messages' => [$this->message('1', 'Invoice overdue', [
            'from' => ['address' => 'billing@supplier.example'],
            'headers' => ['authentication-results' => 'mx.company.example; spf=pass; dkim=pass; dmarc=pass header.from=supplier.example'],
        ])]]);
        $this->runClassification();

        $threads = array_column($this->changes(0)['threads'], null, 'subject');
        self::assertSame([$inboxes['spam'], 'none', 'server_spam'], $this->classificationOf($threads['Invoice overdue']));
    }

    public function testCorrectionSaysWhenTheServersSpamVerdictKeepsWinning(): void
    {
        $this->ingest('messages', ['folder' => 'Junk', 'messages' => [$this->message('1', 'Invoice', ['from' => ['address' => 'billing@supplier.example']])]]);
        $this->ingest('messages', ['folder' => 'INBOX', 'messages' => [$this->message('2', 'Budget')]]);
        $this->runClassification();
        $first = $this->changes(0);
        $inboxes = $this->builtinIds($first);
        $threads = array_column($first['threads'], null, 'subject');
        self::assertSame('server_spam', $threads['Invoice']['classificationReason']);

        $this->client->jsonRequest('PUT', '/api/v1/threads/'.$threads['Invoice']['id'].'/classification', ['smartInboxId' => $inboxes['todo']], $this->kim);
        self::assertResponseIsSuccessful();
        self::assertSame('server_spam', $this->senderRuleOfResponse()['spamOverrules'] ?? null);

        $this->client->jsonRequest('PUT', '/api/v1/threads/'.$threads['Budget']['id'].'/classification', ['smartInboxId' => $inboxes['informational']], $this->kim);
        self::assertResponseIsSuccessful();
        self::assertArrayHasKey('spamOverrules', $this->senderRuleOfResponse());
        self::assertNull($this->senderRuleOfResponse()['spamOverrules']);
    }

    public function testCorrectionSaysWhenTheSendersMailFailsAuthentication(): void
    {
        $this->ingest('messages', ['folder' => 'INBOX', 'messages' => [
            $this->message('1', 'Statement', ['from' => ['address' => 'news@bank.example'], 'headers' => ['authentication-results' => 'mx.google.com; dmarc=fail (p=REJECT) header.from=bank.example']]),
        ]]);
        // At Gmail the topmost Authentication-Results header is always Gmail's own, so a failure there counts.
        $this->connection()->executeStatement("UPDATE mail_account SET provider = 'gmail' WHERE id = :id", ['id' => $this->accountId]);
        $this->runClassification();
        $first = $this->changes(0);
        self::assertSame('authentication_failed', $first['threads'][0]['classificationReason']);

        $this->client->jsonRequest('PUT', '/api/v1/threads/'.$first['threads'][0]['id'].'/classification', ['smartInboxId' => $this->builtinIds($first)['informational']], $this->kim);

        self::assertResponseIsSuccessful();
        self::assertSame('authentication_failed', $this->senderRuleOfResponse()['spamOverrules'] ?? null);
    }

    public function testADmarcFailureCountsEvenOnAGenericImapAccountAndBeatsASenderRule(): void
    {
        // A forged failure could only send the forger's own mail to Spam; a forged From with a real failure must not
        // reach To do through the rule for that address.
        $this->connection()->executeStatement(
            "INSERT INTO sender_rule (id, owner_id, sender, category_id, verdict, updated_at)
             SELECT :id, c.owner_id, 'ceo@bank.example', c.id, 'do', NOW() FROM category c JOIN app_user u ON u.id = c.owner_id
             WHERE u.email = 'kim@example.test' AND c.builtin = 'todo'",
            ['id' => Uuid::v7()->toRfc4122()],
        );
        $this->ingest('messages', ['folder' => 'INBOX', 'messages' => [
            $this->message('1', 'Wire this today', ['from' => ['address' => 'ceo@bank.example'], 'headers' => ['authentication-results' => 'mx.company.example; dmarc=fail (p=REJECT) header.from=bank.example']]),
        ]]);
        $this->runClassification();

        $thread = $this->changes(0)['threads'][0];
        self::assertSame([$this->builtinIds($this->changes(0))['spam'], 'none', 'authentication_failed'], $this->classificationOf($thread));
    }

    public function testForgettingASenderRuleWaitsForACorrectionOfTheUser(): void
    {
        // Made without a correction: in a test everything runs in one transaction, which would keep that lock.
        $ruleId = Uuid::v7()->toRfc4122();
        $this->connection()->executeStatement(
            "INSERT INTO sender_rule (id, owner_id, sender, category_id, verdict, updated_at)
             SELECT :id, c.owner_id, 'anna@partner.example', c.id, NULL, NOW() FROM category c JOIN app_user u ON u.id = c.owner_id
             WHERE u.email = 'kim@example.test' AND c.builtin = 'informational'",
            ['id' => $ruleId],
        );

        $correcting = DriverManager::getConnection($this->separateConnectionParams());
        $correcting->executeStatement('SELECT pg_advisory_lock(hashtextextended(:key, 0))', ['key' => 'classify:'.$this->kimsId()->toRfc4122()]);
        $this->connection()->executeStatement("SET lock_timeout = '300ms'");
        $log = static::getContainer()->get(QueryLog::class);
        try {
            $log->clear();
            $this->client->request('DELETE', '/api/v1/sender-rules/'.$ruleId, server: $this->kim);

            self::assertResponseStatusCodeSame(500);
            self::assertStringContainsString('55P03', (string) $this->client->getResponse()->getContent(), 'Forgetting the rule waited for the correction holding the lock.');
            self::assertNotSame([], $log->queries(), 'The request was recorded.');
            $readsBeforeTheLock = [];
            foreach ($log->queries() as $sql) {
                if (str_contains($sql, 'pg_advisory_xact_lock')) {
                    break;
                }
                if (str_contains($sql, 'sender_rule')) {
                    $readsBeforeTheLock[] = $sql;
                }
            }
            self::assertSame([], $readsBeforeTheLock, 'The rule is looked up only once the lock is held.');
        } finally {
            $this->connection()->executeStatement('RESET lock_timeout');
            $correcting->executeStatement('SELECT pg_advisory_unlock_all()');
            $correcting->close();
        }
    }

    public function testCorrectionsNeedTheSettingsWriteScope(): void
    {
        $this->ingest('messages', ['folder' => 'INBOX', 'messages' => [$this->message('1', 'Budget')]]);
        $this->runClassification();
        $first = $this->changes(0);

        $this->client->jsonRequest('PUT', '/api/v1/threads/'.$first['threads'][0]['id'].'/classification', ['smartInboxId' => $this->builtinIds($first)['informational']], $this->userHeaders('kim@example.test', ['mail:read', 'mail:write']));

        self::assertResponseStatusCodeSame(403);
    }

    public function testOtherUsersCannotForgetASenderRule(): void
    {
        $this->ingest('messages', ['folder' => 'INBOX', 'messages' => [$this->message('1', 'Budget')]]);
        $this->runClassification();
        $first = $this->changes(0);
        $this->client->jsonRequest('PUT', '/api/v1/threads/'.$first['threads'][0]['id'].'/classification', ['smartInboxId' => $this->builtinIds($first)['informational']], $this->kim);
        $rule = $this->decodedResponse()['senderRule'] ?? null;
        self::assertIsArray($rule);
        $ruleId = $rule['id'] ?? null;
        self::assertIsString($ruleId);

        $this->client->request('DELETE', '/api/v1/sender-rules/'.$ruleId, server: $this->userHeaders('lisa@example.test', ['settings:read', 'settings:write']));
        self::assertResponseStatusCodeSame(404);

        $this->client->request('GET', '/api/v1/sender-rules', server: $this->kim);
        self::assertCount(1, $this->decodedResponse());
    }

    public function testMailFiledOnlyAsSentIsTheUsersOwnEvenFromAnAlias(): void
    {
        $this->ingest('messages', ['folder' => 'Sent', 'messages' => [$this->message('1', 'From my alias', ['from' => ['address' => 'kim@alias.example'], 'to' => [['address' => 'anna@partner.example']]])]]);
        $this->runClassification();

        self::assertSame([null, null, null], $this->classificationOf($this->changes(0)['threads'][0]));
    }

    public function testLongRunsStopAfterTheirBatchesAndSayMoreIsLeft(): void
    {
        foreach ([1, 2] as $part) {
            $this->ingest('messages', ['folder' => 'INBOX', 'messages' => array_map(fn (int $i): array => $this->message($part.'-'.$i, 'Mail '.$part.'-'.$i), range(1, 101))]);
        }
        $this->takeQueued();
        $userId = $this->connection()->fetchOne("SELECT id FROM app_user WHERE email = 'kim@example.test'");
        self::assertIsString($userId);
        $classification = static::getContainer()->get(MailClassification::class);

        self::assertTrue($classification->classifyNew(Uuid::fromString($userId), 1));
        self::assertEquals(2, $this->connection()->fetchOne('SELECT COUNT(*) FROM message WHERE classified_at IS NULL'));
        self::assertFalse($classification->classifyNew(Uuid::fromString($userId), 1));
        self::assertEquals(0, $this->connection()->fetchOne('SELECT COUNT(*) FROM message WHERE classified_at IS NULL'));
    }

    private function releaseUrl(string $threadId, string $placementId): string
    {
        return '/api/v1/threads/'.$threadId.'/classification?'.http_build_query(['placementId' => $placementId]);
    }

    /**
     * Places the conversation as the user and returns the placement's id.
     *
     * @param array<string, mixed> $placement
     */
    private function place(string $threadId, array $placement): string
    {
        $this->client->jsonRequest('PUT', '/api/v1/threads/'.$threadId.'/classification', $placement, $this->kim);
        self::assertResponseIsSuccessful();
        $placementId = $this->decodedResponse()['placementId'] ?? null;
        self::assertIsString($placementId);

        return $placementId;
    }

    /** @return array<mixed> */
    private function senderRuleOfResponse(): array
    {
        $rule = $this->decodedResponse()['senderRule'] ?? null;
        self::assertIsArray($rule);

        return $rule;
    }

    private function kimsId(): Uuid
    {
        $id = $this->connection()->fetchOne("SELECT id FROM app_user WHERE email = 'kim@example.test'");
        self::assertIsString($id);

        return Uuid::fromString($id);
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

    public function testCommandClassifiesAgain(): void
    {
        $this->ingest('messages', ['folder' => 'INBOX', 'messages' => [$this->message('1', 'Budget')]]);
        $this->classifyTransport()->reset();

        $tester = new CommandTester(new Application($this->client->getKernel())->find('app:classification:rerun'));
        $tester->execute(['--user' => ['kim@example.test'], '--days' => '0']);

        $tester->assertCommandIsSuccessful();
        self::assertSame('direct', $this->changes(0)['threads'][0]['classificationReason']);
    }

    /**
     * Handles what the last request queued (or the given envelopes), the way the messenger worker would. The test
     * client empties the in-memory transport before every request, so this runs right after the request that queued.
     *
     * @param list<Envelope>|null $envelopes
     */
    private function runClassification(?array $envelopes = null): void
    {
        $bus = static::getContainer()->get(MessageBusInterface::class);
        $envelopes ??= $this->takeQueued();
        while ([] !== $envelopes) {
            foreach ($envelopes as $envelope) {
                $bus->dispatch($envelope->with(new ReceivedStamp('classify')));
            }
            $envelopes = $this->takeQueued();
        }
    }

    /**
     * @phpstan-impure
     *
     * @return list<Envelope>
     */
    private function takeQueued(): array
    {
        $transport = $this->classifyTransport();
        $envelopes = array_values([...$transport->get()]);
        $transport->reset();

        return $envelopes;
    }

    private function classifyTransport(): InMemoryTransport
    {
        $transport = static::getContainer()->get('messenger.transport.classify');
        self::assertInstanceOf(InMemoryTransport::class, $transport);

        return $transport;
    }

    /**
     * @param array{smartInboxes: list<array<string, mixed>>} $page
     *
     * @return array<string, string> built-in smart inbox ids by kind
     */
    private function builtinIds(array $page): array
    {
        $ids = [];
        foreach ($page['smartInboxes'] as $smartInbox) {
            if (\is_string($smartInbox['builtin']) && \is_string($smartInbox['id'])) {
                $ids[$smartInbox['builtin']] = $smartInbox['id'];
            }
        }

        return $ids;
    }

    /**
     * @param array{smartInboxId: ?string, verdict: ?string, classificationReason: ?string} $thread
     *
     * @return array{?string, ?string, ?string}
     */
    private function classificationOf(array $thread): array
    {
        return [$thread['smartInboxId'], $thread['verdict'], $thread['classificationReason']];
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
     * @return array{cursor: int, smartInboxes: list<array<string, mixed>>, threads: list<array{id: string, subject: string, smartInboxId: ?string, verdict: ?string, classificationReason: ?string}>, messages: list<array{id: string, subject: string, smartInboxId: ?string, verdict: ?string}>, deleted: list<array{type: string, id: string}>}
     */
    private function changes(int $since): array
    {
        $this->client->request('GET', \sprintf('/api/v1/sync/changes?since=%d&limit=2000', $since), server: $this->kim);
        self::assertResponseIsSuccessful();

        /** @var array{cursor: int, smartInboxes: list<array<string, mixed>>, threads: list<array{id: string, subject: string, smartInboxId: ?string, verdict: ?string, classificationReason: ?string}>, messages: list<array{id: string, subject: string, smartInboxId: ?string, verdict: ?string}>, deleted: list<array{type: string, id: string}>} */
        return $this->decodedResponse();
    }

    /**
     * Yesterday at this hour (UTC): a correction classifies again only mail of the last 30 days
     * (ClassificationScheduler::RECLASSIFY_PERIOD), so a fixed date stops being reclassified once it is older.
     */
    private static function receivedAt(int $hour): string
    {
        return new \DateTimeImmutable('yesterday', new \DateTimeZone('UTC'))->setTime($hour, 0)->format(\DATE_ATOM);
    }

    /**
     * @param array<string, mixed> $override
     *
     * @return array<string, mixed>
     */
    private function message(string $uid, string $subject, array $override = []): array
    {
        $sha = hash('sha256', $uid.$subject);

        return [...[
            'remoteUid' => $uid,
            'rawObjectKey' => $this->rawKeyFor($this->accountId, $uid.$subject),
            'keyVersion' => 1,
            'size' => 100,
            'receivedAt' => self::receivedAt(8),
            'messageId' => '<'.$sha.'@x>',
            'subject' => $subject,
            'from' => ['address' => 'anna@partner.example', 'name' => 'Anna'],
            'to' => [['address' => self::ME]],
            'snippet' => 'Hello',
        ], ...$override];
    }
}
