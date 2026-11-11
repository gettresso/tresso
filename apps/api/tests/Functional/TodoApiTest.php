<?php

declare(strict_types=1);

namespace App\Tests\Functional;

use App\Tests\Support\QueryLog;
use Doctrine\ORM\EntityManagerInterface;
use Symfony\Component\Messenger\Envelope;
use Symfony\Component\Messenger\MessageBusInterface;
use Symfony\Component\Messenger\Stamp\ReceivedStamp;
use Symfony\Component\Messenger\Transport\InMemory\InMemoryTransport;

/**
 * Todos through the API and the delta: the user's own, made from an email, and made automatically by a smart inbox.
 */
final class TodoApiTest extends DatabaseTestCase
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
        $this->kim = $this->userHeaders('kim@example.test', ['mail:read', 'mail:write', 'settings:read', 'settings:write', 'todos:read', 'todos:write']);

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
        $this->ingest('folders', ['folders' => [['remoteName' => 'INBOX', 'displayName' => 'Inbox', 'role' => 'inbox', 'uidValidity' => 1]]]);
    }

    public function testCreateGoesLastAndListsOpenTodosBeforeDoneOnes(): void
    {
        $first = $this->create(['title' => '  Book the venue ', 'notes' => 'Ask for the big room', 'dueDate' => '2026-10-24', 'dueTime' => '17:00', 'durationMinutes' => 30]);
        $second = $this->create(['title' => 'Renew the passport']);
        $third = $this->create(['title' => 'Send the slides']);
        $this->patch($first['id'], ['done' => true]);

        self::assertSame('Book the venue', $first['title']);
        self::assertSame('Ask for the big room', $first['notes']);
        self::assertSame(['2026-10-24', '17:00', 30], [$first['dueDate'], $first['dueTime'], $first['durationMinutes']]);
        self::assertSame(['manual', null, null, null], [$first['source'], $first['messageId'], $first['threadId'], $first['completedAt']]);
        self::assertSame([0, 1, 2], [$first['position'], $second['position'], $third['position']]);

        $this->client->request('GET', '/api/v1/todos', server: $this->kim);
        self::assertResponseIsSuccessful();
        self::assertSame(['Renew the passport', 'Send the slides', 'Book the venue'], array_column($this->decodedResponse(), 'title'));
    }

    /**
     * @param array<string, mixed> $input
     */
    #[\PHPUnit\Framework\Attributes\DataProvider('invalidTodos')]
    public function testCreateRefusesInvalidTodos(array $input, string $field): void
    {
        $this->client->jsonRequest('POST', '/api/v1/todos', $input, $this->kim);

        self::assertResponseStatusCodeSame(422);
        self::assertContains($field, $this->violationPaths());
    }

    /**
     * @return iterable<string, array{array<string, mixed>, string}>
     */
    public static function invalidTodos(): iterable
    {
        yield 'blank title' => [['title' => '  '], 'title'];
        yield 'title too long' => [['title' => str_repeat('a', 501)], 'title'];
        yield 'time without a date' => [['title' => 'Call Anna', 'dueTime' => '09:00'], 'dueTime'];
        yield 'not a date' => [['title' => 'Call Anna', 'dueDate' => '2026-02-30'], 'dueDate'];
        yield 'not a time' => [['title' => 'Call Anna', 'dueDate' => '2026-10-24', 'dueTime' => '25:00'], 'dueTime'];
        yield 'no duration' => [['title' => 'Call Anna', 'durationMinutes' => 0], 'durationMinutes'];
    }

    public function testPatchChangesOnlyWhatItSends(): void
    {
        $todo = $this->create(['title' => 'Book the venue', 'notes' => 'Big room', 'dueDate' => '2026-10-24', 'dueTime' => '17:00', 'durationMinutes' => 30]);

        $moved = $this->patch($todo['id'], ['dueDate' => '2026-10-27']);
        self::assertSame(['Book the venue', 'Big room', '2026-10-27', '17:00', 30], [$moved['title'], $moved['notes'], $moved['dueDate'], $moved['dueTime'], $moved['durationMinutes']]);

        $allDay = $this->patch($todo['id'], ['dueTime' => null, 'durationMinutes' => null]);
        self::assertSame(['2026-10-27', null, null], [$allDay['dueDate'], $allDay['dueTime'], $allDay['durationMinutes']]);

        $timed = $this->patch($todo['id'], ['dueTime' => '09:30']);
        $cleared = $this->patch($todo['id'], ['dueDate' => null]);
        self::assertSame('09:30', $timed['dueTime']);
        self::assertSame([null, null], [$cleared['dueDate'], $cleared['dueTime']], 'A cleared date takes its time with it.');
    }

    public function testPatchRefusesATimeWithoutADate(): void
    {
        $todo = $this->create(['title' => 'Call Anna']);

        $this->client->jsonRequest('PATCH', '/api/v1/todos/'.$todo['id'], ['dueTime' => '09:00'], $this->kim + ['CONTENT_TYPE' => 'application/merge-patch+json']);

        self::assertResponseStatusCodeSame(422);
    }

    public function testDoneKeepsTheMomentItWasFirstDoneAndReopens(): void
    {
        $todo = $this->create(['title' => 'Call Anna']);

        $done = $this->patch($todo['id'], ['done' => true]);
        $again = $this->patch($todo['id'], ['done' => true]);
        $reopened = $this->patch($todo['id'], ['done' => false]);

        self::assertNotNull($done['completedAt']);
        self::assertSame($done['completedAt'], $again['completedAt']);
        self::assertNull($reopened['completedAt']);
    }

    public function testTodosReachClientsThroughTheDeltaAndDeletesLeaveATombstone(): void
    {
        $todo = $this->create(['title' => 'Call Anna', 'dueDate' => '2026-10-24', 'dueTime' => '09:00', 'durationMinutes' => 15]);

        $page = $this->changes(0);
        self::assertSame([$todo['id']], array_column($page['todos'], 'id'));
        $synced = $page['todos'][0];
        self::assertSame(['Call Anna', '2026-10-24', '09:00', 15, 'manual', null], [$synced['title'], $synced['dueDate'], $synced['dueTime'], $synced['durationMinutes'], $synced['source'], $synced['completedAt']]);

        $this->patch($todo['id'], ['done' => true]);
        $changed = $this->changes($page['cursor']);
        self::assertSame([$todo['id']], array_column($changed['todos'], 'id'));
        self::assertNotNull($changed['todos'][0]['completedAt']);

        $this->client->request('DELETE', '/api/v1/todos/'.$todo['id'], server: $this->kim);
        self::assertResponseStatusCodeSame(204);
        $deleted = $this->changes($changed['cursor']);
        self::assertSame([], $deleted['todos']);
        self::assertSame([['type' => 'todo', 'id' => $todo['id']]], $deleted['deleted']);
    }

    public function testMakingATodoFromAnEmailUsesItsSubjectAndIsIdempotent(): void
    {
        $this->ingest('messages', ['folder' => 'INBOX', 'messages' => [$this->message('1', 'Budget review', ['flags' => ['seen' => true]])]]);
        $message = $this->messageBySubject('Budget review');

        $this->client->jsonRequest('POST', '/api/v1/messages/'.$message['id'].'/todo', ['dueDate' => '2026-10-24'], $this->kim);
        self::assertResponseStatusCodeSame(200);
        $made = $this->decodedResponse();
        self::assertSame(['Budget review', 'manual', $message['id'], $message['threadId'], '2026-10-24'], [$made['title'], $made['source'], $made['messageId'], $made['threadId'], $made['dueDate']]);

        $this->client->jsonRequest('POST', '/api/v1/messages/'.$message['id'].'/todo', ['title' => 'Something else'], $this->kim);
        self::assertResponseStatusCodeSame(200);
        $again = $this->decodedResponse();
        self::assertSame([$made['id'], 'Budget review'], [$again['id'], $again['title']], 'An email has one todo.');
        self::assertEquals(1, $this->connection()->fetchOne('SELECT COUNT(*) FROM todo'));
    }

    public function testMakingATodoFromAnEmailSaysWhetherItMadeIt(): void
    {
        $this->ingest('messages', ['folder' => 'INBOX', 'messages' => [$this->message('1', 'Budget review', ['flags' => ['seen' => true]])]]);
        $message = $this->messageBySubject('Budget review');

        $this->client->jsonRequest('POST', '/api/v1/messages/'.$message['id'].'/todo', [], $this->kim);
        $first = $this->decodedResponse();
        $this->client->jsonRequest('POST', '/api/v1/messages/'.$message['id'].'/todo', [], $this->kim);
        $again = $this->decodedResponse();
        $this->client->request('GET', '/api/v1/todos', server: $this->kim);
        $listed = $this->decodedResponse()[0] ?? null;

        self::assertTrue($first['made'] ?? null);
        self::assertFalse($again['made'] ?? null, 'The one it had: an undo must leave it.');
        self::assertIsArray($listed);
        self::assertArrayHasKey('made', $listed);
        self::assertNull($listed['made'], 'Only making one says it.');
    }

    public function testMakingOnePerConversationAnswersWithTheConversationsOpenTodo(): void
    {
        $this->ingest('messages', ['folder' => 'INBOX', 'messages' => [
            $this->message('1', 'Budget review', ['messageId' => '<budget@x>', 'flags' => ['seen' => true]]),
            $this->message('2', 'Re: Budget review', ['messageId' => '<reply@x>', 'inReplyTo' => '<budget@x>', 'receivedAt' => '2026-10-19T09:00:00+00:00', 'flags' => ['seen' => true]]),
        ]]);
        $first = $this->messageBySubject('Budget review');
        $reply = $this->messageBySubject('Re: Budget review');
        $this->client->jsonRequest('POST', '/api/v1/messages/'.$first['id'].'/todo', [], $this->kim);
        $open = $this->responseString('id');

        $this->client->jsonRequest('POST', '/api/v1/messages/'.$reply['id'].'/todo', ['perConversation' => true], $this->kim);

        self::assertSame([$open, false], [$this->decodedResponse()['id'] ?? null, $this->decodedResponse()['made'] ?? null]);
        self::assertEquals(1, $this->connection()->fetchOne('SELECT COUNT(*) FROM todo'));

        $this->patch($open, ['done' => true]);
        $this->client->jsonRequest('POST', '/api/v1/messages/'.$reply['id'].'/todo', ['perConversation' => true], $this->kim);
        self::assertTrue($this->decodedResponse()['made'] ?? null, 'A done todo leaves room for a new one.');
    }

    public function testTakingBackAPlacementGivesTheMailTheTodoItWouldHaveGot(): void
    {
        $this->ingest('messages', ['folder' => 'INBOX', 'messages' => [$this->message('1', 'Budget review')]]);
        // Placed by the user before classification ran: classification leaves it alone, so it got no automatic todo.
        $queued = $this->takeQueued();
        $message = $this->messageBySubject('Budget review');
        $this->client->request('GET', '/api/v1/smart-inboxes', server: $this->kim);
        $informational = array_column($this->decodedResponse(), 'id', 'builtin')['informational'] ?? null;
        self::assertIsString($informational);
        $this->client->jsonRequest('PUT', '/api/v1/threads/'.$message['threadId'].'/classification', ['smartInboxId' => $informational, 'remember' => false], $this->kim);
        $placementId = $this->responseString('placementId');
        $this->runClassification($queued);
        self::assertEquals(0, $this->connection()->fetchOne('SELECT COUNT(*) FROM todo'));

        $this->client->request('DELETE', '/api/v1/threads/'.$message['threadId'].'/classification?placementId='.$placementId, server: $this->kim);

        self::assertResponseStatusCodeSame(204);
        $todos = $this->changes(0)['todos'];
        self::assertSame([['Budget review', 'automatic', $message['id']]], array_map(static fn (array $todo): array => [$todo['title'], $todo['source'], $todo['messageId']], $todos));
    }

    public function testTakingBackAPlacementLeavesAnAutomaticTodoTheUserDeletedDeleted(): void
    {
        $this->ingest('messages', ['folder' => 'INBOX', 'messages' => [$this->message('1', 'Budget review')]]);
        $this->runClassification();
        $message = $this->messageBySubject('Budget review');
        $automatic = $this->changes(0)['todos'][0]['id'] ?? null;
        self::assertIsString($automatic);
        $this->client->request('DELETE', '/api/v1/todos/'.$automatic, server: $this->kim);
        self::assertResponseStatusCodeSame(204);
        $placementId = $this->placeAsInformational($message['threadId']);

        $this->client->request('DELETE', '/api/v1/threads/'.$message['threadId'].'/classification?placementId='.$placementId, server: $this->kim);

        self::assertResponseStatusCodeSame(204);
        self::assertEquals(0, $this->connection()->fetchOne('SELECT COUNT(*) FROM todo'), 'The user did not want it.');
    }

    public function testDeletingATodoMadeByHandDoesNotDeclineTheAutomaticOne(): void
    {
        $this->ingest('messages', ['folder' => 'INBOX', 'messages' => [$this->message('1', 'Budget review')]]);
        $queued = $this->takeQueued();
        $message = $this->messageBySubject('Budget review');
        $placementId = $this->placeAsInformational($message['threadId']);
        $this->runClassification($queued);
        // Triage's do made a todo by hand; its undo removes it again before taking the placement back.
        $this->client->jsonRequest('POST', '/api/v1/messages/'.$message['id'].'/todo', ['perConversation' => true], $this->kim);
        $this->client->request('DELETE', '/api/v1/todos/'.$this->responseString('id'), server: $this->kim);

        $this->client->request('DELETE', '/api/v1/threads/'.$message['threadId'].'/classification?placementId='.$placementId, server: $this->kim);

        self::assertSame(['automatic'], array_column($this->changes(0)['todos'], 'source'));
    }

    public function testATodoMadeFromAnEmailWithoutSubjectIsNamedAfterTheSender(): void
    {
        $this->ingest('messages', ['folder' => 'INBOX', 'messages' => [$this->message('1', '', ['flags' => ['seen' => true]])]]);
        $message = $this->messageBySubject('');

        $this->client->jsonRequest('POST', '/api/v1/messages/'.$message['id'].'/todo', [], $this->kim);

        self::assertSame('Email from Anna', $this->responseString('title'));
    }

    public function testOtherUsersTodosAndEmailsLookLikeTheyDoNotExist(): void
    {
        $this->ingest('messages', ['folder' => 'INBOX', 'messages' => [$this->message('1', 'Budget review', ['flags' => ['seen' => true]])]]);
        $message = $this->messageBySubject('Budget review');
        $todo = $this->create(['title' => 'Call Anna']);
        $lisa = $this->userHeaders('lisa@example.test', ['mail:read', 'todos:read', 'todos:write']);

        $this->client->request('GET', '/api/v1/todos/'.$todo['id'], server: $lisa);
        self::assertResponseStatusCodeSame(404);
        $this->client->jsonRequest('PATCH', '/api/v1/todos/'.$todo['id'], ['done' => true], $lisa + ['CONTENT_TYPE' => 'application/merge-patch+json']);
        self::assertResponseStatusCodeSame(404);
        $this->client->request('DELETE', '/api/v1/todos/'.$todo['id'], server: $lisa);
        self::assertResponseStatusCodeSame(404);
        $this->client->jsonRequest('POST', '/api/v1/messages/'.$message['id'].'/todo', [], $lisa);
        self::assertResponseStatusCodeSame(404);
        $this->client->request('GET', '/api/v1/todos', server: $lisa);
        self::assertSame([], $this->decodedResponse());
        $this->client->request('GET', '/api/v1/sync/changes?since=0', server: $lisa);
        self::assertSame([], $this->decodedResponse()['todos'] ?? null);
    }

    public function testTodosNeedTheirScopes(): void
    {
        $readOnly = $this->userHeaders('kim@example.test', ['mail:read', 'todos:read']);
        $mailOnly = $this->userHeaders('kim@example.test', ['mail:read', 'mail:write']);

        $this->client->jsonRequest('POST', '/api/v1/todos', ['title' => 'Call Anna'], $readOnly);
        self::assertResponseStatusCodeSame(403);
        $this->client->request('GET', '/api/v1/todos', server: $mailOnly);
        self::assertResponseStatusCodeSame(403);
    }

    public function testNewMailInTheToDoSmartInboxBecomesATodoOnce(): void
    {
        $this->ingest('messages', ['folder' => 'INBOX', 'messages' => [$this->message('1', 'Budget review')]]);
        $this->runClassification();
        $message = $this->messageBySubject('Budget review');

        $todos = $this->changes(0)['todos'];
        self::assertCount(1, $todos);
        self::assertSame(['Budget review', 'automatic', $message['id'], $message['threadId']], [$todos[0]['title'], $todos[0]['source'], $todos[0]['messageId'], $todos[0]['threadId']]);

        // Classifying again (after a change to the smart inboxes) and making one by hand give no second todo.
        $todoInbox = $this->builtinToDoSmartInbox();
        $this->client->jsonRequest('PATCH', '/api/v1/smart-inboxes/'.$todoInbox['id'], ['instructions' => 'Things I must do'], $this->kim + ['CONTENT_TYPE' => 'application/merge-patch+json']);
        $this->runClassification();
        $this->client->jsonRequest('POST', '/api/v1/messages/'.$message['id'].'/todo', [], $this->kim);
        self::assertSame($todos[0]['id'], $this->responseString('id'));
        self::assertEquals(1, $this->connection()->fetchOne('SELECT COUNT(*) FROM todo'));
    }

    public function testOnlyRecentUnreadMailToDoBecomesATodo(): void
    {
        $this->ingest('messages', ['folder' => 'INBOX', 'messages' => [
            $this->message('1', 'Fresh request'),
            $this->message('2', 'Read already', ['flags' => ['seen' => true]]),
            $this->message('3', 'From last month', ['receivedAt' => new \DateTimeImmutable('-30 days')->format(\DATE_ATOM)]),
            $this->message('4', 'Weekly deals', ['from' => ['address' => 'newsletter@shop.example'], 'headers' => ['list-unsubscribe' => '<https://shop.example/u>']]),
        ]]);
        $this->runClassification();

        self::assertSame(['Fresh request'], array_column($this->changes(0)['todos'], 'title'));
    }

    public function testASmartInboxWithoutTheSettingMakesNoTodos(): void
    {
        $todoInbox = $this->builtinToDoSmartInbox();
        self::assertTrue($todoInbox['autoCreateTodo'], 'The built-in To do smart inbox makes todos unless switched off.');
        $this->client->jsonRequest('PATCH', '/api/v1/smart-inboxes/'.$todoInbox['id'], ['autoCreateTodo' => false], $this->kim + ['CONTENT_TYPE' => 'application/merge-patch+json']);
        self::assertResponseIsSuccessful();
        $this->runClassification();

        $this->ingest('messages', ['folder' => 'INBOX', 'messages' => [$this->message('1', 'Budget review')]]);
        $this->runClassification();

        self::assertSame([], $this->changes(0)['todos']);
    }

    public function testOnlyTheDoVerdictCanCreateTodos(): void
    {
        $this->client->jsonRequest('POST', '/api/v1/smart-inboxes', ['name' => 'Reading', 'verdict' => 'know', 'autoCreateTodo' => true], $this->kim);
        self::assertResponseStatusCodeSame(422);
        self::assertContains('autoCreateTodo', $this->violationPaths());

        $this->client->jsonRequest('POST', '/api/v1/smart-inboxes', ['name' => 'Invoices', 'verdict' => 'do', 'autoCreateTodo' => true], $this->kim);
        self::assertResponseStatusCodeSame(201);
        $id = $this->responseString('id');
        self::assertTrue($this->decodedResponse()['autoCreateTodo'] ?? null);

        $this->client->jsonRequest('PATCH', '/api/v1/smart-inboxes/'.$id, ['verdict' => 'know'], $this->kim + ['CONTENT_TYPE' => 'application/merge-patch+json']);
        self::assertResponseIsSuccessful();
        self::assertFalse($this->decodedResponse()['autoCreateTodo'] ?? null, 'Another verdict switches it off.');

        $smartInboxes = array_column($this->changes(0)['smartInboxes'], null, 'id');
        self::assertFalse($smartInboxes[$id]['autoCreateTodo'] ?? null);
    }

    public function testAConversationGetsOneOpenTodoHoweverManyRepliesArrive(): void
    {
        $this->ingest('messages', ['folder' => 'INBOX', 'messages' => [$this->message('1', 'Budget review', ['messageId' => '<budget@x>'])]]);
        $this->runClassification();
        $this->ingest('messages', ['folder' => 'INBOX', 'messages' => [
            $this->message('2', 'Re: Budget review', ['messageId' => '<reply-1@x>', 'inReplyTo' => '<budget@x>', 'from' => ['address' => 'lisa@partner.example']]),
            $this->message('3', 'Re: Budget review', ['messageId' => '<reply-2@x>', 'inReplyTo' => '<reply-1@x>']),
        ]]);
        $this->runClassification();

        $todos = $this->changes(0)['todos'];
        self::assertSame(['Budget review'], array_column($todos, 'title'), 'The replies, one batch of two, make no second todo.');

        // Once that todo is done, the next reply is something new to do.
        $this->patch($todos[0]['id'], ['done' => true]);
        $this->ingest('messages', ['folder' => 'INBOX', 'messages' => [
            $this->message('4', 'Re: Budget review', ['messageId' => '<reply-3@x>', 'inReplyTo' => '<reply-2@x>']),
        ]]);
        $this->runClassification();

        self::assertEquals(2, $this->connection()->fetchOne('SELECT COUNT(*) FROM todo'));
        self::assertEquals(1, $this->connection()->fetchOne('SELECT COUNT(*) FROM todo WHERE completed_at IS NULL'));
    }

    public function testATodoMadeByHandBeforeClassificationLeavesClassificationWorking(): void
    {
        $this->ingest('messages', ['folder' => 'INBOX', 'messages' => [$this->message('1', 'Budget review')]]);
        // Taken now: the test client empties the in-memory queue before every request.
        $queued = $this->takeQueued();
        self::assertCount(1, $queued);
        $message = $this->messageBySubject('Budget review');
        $this->client->jsonRequest('POST', '/api/v1/messages/'.$message['id'].'/todo', [], $this->kim);
        self::assertResponseStatusCodeSame(200);
        // Done already, so only the email's own todo (not an open one in the conversation) keeps a second one away.
        $this->patch($this->responseString('id'), ['done' => true]);

        $this->runClassification($queued);

        self::assertEquals(1, $this->connection()->fetchOne('SELECT COUNT(*) FROM todo'));
        self::assertEquals(0, $this->connection()->fetchOne('SELECT COUNT(*) FROM message WHERE classified_at IS NULL'), 'Classification finished.');
        self::assertSame('manual', $this->changes(0)['todos'][0]['source']);
    }

    public function testDoneTodosComeMostRecentlyDoneFirst(): void
    {
        $first = $this->create(['title' => 'Done first']);
        $second = $this->create(['title' => 'Done last']);
        $this->patch($first['id'], ['done' => true]);
        $this->patch($second['id'], ['done' => true]);
        $this->connection()->executeStatement("UPDATE todo SET completed_at = '2026-10-20 09:00:00' WHERE id = :id", ['id' => $first['id']]);
        $this->connection()->executeStatement("UPDATE todo SET completed_at = '2026-10-20 10:00:00' WHERE id = :id", ['id' => $second['id']]);

        $this->client->request('GET', '/api/v1/todos', server: $this->kim);

        self::assertSame(['Done last', 'Done first'], array_column($this->decodedResponse(), 'title'));
    }

    public function testListingTodosLoadsTheirEmailsInTheSameQuery(): void
    {
        $this->ingest('messages', ['folder' => 'INBOX', 'messages' => [
            $this->message('1', 'Budget review', ['flags' => ['seen' => true]]),
            $this->message('2', 'Offsite', ['flags' => ['seen' => true]]),
            $this->message('3', 'Slides', ['flags' => ['seen' => true]]),
        ]]);
        foreach (['Budget review', 'Offsite', 'Slides'] as $subject) {
            $this->client->jsonRequest('POST', '/api/v1/messages/'.$this->messageBySubject($subject)['id'].'/todo', [], $this->kim);
        }
        static::getContainer()->get(EntityManagerInterface::class)->clear();
        $log = static::getContainer()->get(QueryLog::class);
        $log->clear();

        $this->client->request('GET', '/api/v1/todos', server: $this->kim);

        self::assertResponseIsSuccessful();
        self::assertCount(3, array_filter(array_column($this->decodedResponse(), 'threadId')));
        $lazy = array_filter($log->queries(), static fn (string $sql): bool => (bool) preg_match('/^SELECT .* FROM (message|thread) /s', $sql));
        self::assertSame([], array_values($lazy), 'No email or conversation is loaded one by one.');
    }

    public function testATodoLosesItsLinkVisiblyWhenItsEmailIsGone(): void
    {
        $this->ingest('messages', ['folder' => 'INBOX', 'messages' => [$this->message('1', 'Budget review', ['flags' => ['seen' => true]])]]);
        $message = $this->messageBySubject('Budget review');
        $this->client->jsonRequest('POST', '/api/v1/messages/'.$message['id'].'/todo', [], $this->kim);
        $cursor = $this->changes(0)['cursor'];

        $this->ingest('changes', ['folder' => 'INBOX', 'vanished' => ['1'], 'cursor' => 'modseq=2']);
        $this->sweepOrphanedMessages();

        $page = $this->changes($cursor);
        self::assertSame([[null, null]], array_map(static fn (array $todo): array => [$todo['messageId'], $todo['threadId']], $page['todos']));
        self::assertContains(['type' => 'message', 'id' => $message['id']], $page['deleted']);
    }

    public function testATodoLosesItsLinkVisiblyWhenItsAccountIsRemoved(): void
    {
        $this->ingest('messages', ['folder' => 'INBOX', 'messages' => [$this->message('1', 'Budget review', ['flags' => ['seen' => true]])]]);
        $message = $this->messageBySubject('Budget review');
        $this->client->jsonRequest('POST', '/api/v1/messages/'.$message['id'].'/todo', [], $this->kim);
        $cursor = $this->changes(0)['cursor'];

        $this->client->request('DELETE', '/api/v1/mail-accounts/'.$this->accountId, server: $this->kim);
        self::assertResponseStatusCodeSame(204);

        $page = $this->changes($cursor);
        self::assertSame([['Budget review', null, null]], array_map(static fn (array $todo): array => [$todo['title'], $todo['messageId'], $todo['threadId']], $page['todos']));
    }

    /**
     * @param array<string, mixed> $input
     *
     * @return array{id: string, title: string, notes: string, dueDate: ?string, dueTime: ?string, durationMinutes: ?int, completedAt: ?string, position: int, source: string, messageId: ?string, threadId: ?string}
     */
    private function create(array $input): array
    {
        $this->client->jsonRequest('POST', '/api/v1/todos', $input, $this->kim);
        self::assertResponseStatusCodeSame(201);

        return $this->todoResponse();
    }

    /**
     * @param array<string, mixed> $changes
     *
     * @return array{id: string, title: string, notes: string, dueDate: ?string, dueTime: ?string, durationMinutes: ?int, completedAt: ?string, position: int, source: string, messageId: ?string, threadId: ?string}
     */
    private function patch(string $id, array $changes): array
    {
        $this->client->jsonRequest('PATCH', '/api/v1/todos/'.$id, $changes, $this->kim + ['CONTENT_TYPE' => 'application/merge-patch+json']);
        self::assertResponseIsSuccessful();

        return $this->todoResponse();
    }

    /**
     * @return array{id: string, title: string, notes: string, dueDate: ?string, dueTime: ?string, durationMinutes: ?int, completedAt: ?string, position: int, source: string, messageId: ?string, threadId: ?string}
     */
    private function todoResponse(): array
    {
        $todo = $this->decodedResponse();
        self::assertIsString($todo['id'] ?? null);

        /** @var array{id: string, title: string, notes: string, dueDate: ?string, dueTime: ?string, durationMinutes: ?int, completedAt: ?string, position: int, source: string, messageId: ?string, threadId: ?string} */
        return $todo;
    }

    /**
     * @return list<string>
     */
    private function violationPaths(): array
    {
        /** @var list<array{propertyPath: string}> $violations */
        $violations = $this->decodedResponse()['violations'] ?? [];

        return array_column($violations, 'propertyPath');
    }

    /** Places the conversation in Informational as the user, for this conversation only; returns the placement's id. */
    private function placeAsInformational(string $threadId): string
    {
        $this->client->request('GET', '/api/v1/smart-inboxes', server: $this->kim);
        $informational = array_column($this->decodedResponse(), 'id', 'builtin')['informational'] ?? null;
        self::assertIsString($informational);
        $this->client->jsonRequest('PUT', '/api/v1/threads/'.$threadId.'/classification', ['smartInboxId' => $informational, 'remember' => false], $this->kim);

        return $this->responseString('placementId');
    }

    /**
     * @return array{id: string, autoCreateTodo: bool}
     */
    private function builtinToDoSmartInbox(): array
    {
        $this->client->request('GET', '/api/v1/smart-inboxes', server: $this->kim);
        /** @var list<array{id: string, builtin: ?string, autoCreateTodo: bool}> $smartInboxes */
        $smartInboxes = $this->decodedResponse();
        $todo = array_column($smartInboxes, null, 'builtin')['todo'] ?? null;
        self::assertIsArray($todo);

        return $todo;
    }

    /**
     * @return array{id: string, threadId: string}
     */
    private function messageBySubject(string $subject): array
    {
        $message = array_column($this->changes(0)['messages'], null, 'subject')[$subject] ?? null;
        self::assertIsArray($message);
        self::assertIsString($message['id']);
        self::assertIsString($message['threadId']);

        return ['id' => $message['id'], 'threadId' => $message['threadId']];
    }

    /**
     * Runs queued classification jobs the way the messenger worker does, these first when given, until none are left.
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
        $transport = static::getContainer()->get('messenger.transport.classify');
        self::assertInstanceOf(InMemoryTransport::class, $transport);
        $envelopes = array_values([...$transport->get()]);
        $transport->reset();

        return $envelopes;
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
     * @return array{cursor: int, smartInboxes: list<array<string, mixed>>, messages: list<array<string, mixed>>, todos: list<array{id: string, title: string, notes: string, dueDate: ?string, dueTime: ?string, durationMinutes: ?int, completedAt: ?string, position: int, source: string, messageId: ?string, threadId: ?string}>, deleted: list<array{type: string, id: string}>}
     */
    private function changes(int $since): array
    {
        $this->client->request('GET', \sprintf('/api/v1/sync/changes?since=%d&limit=2000', $since), server: $this->kim);
        self::assertResponseIsSuccessful();

        /** @var array{cursor: int, smartInboxes: list<array<string, mixed>>, messages: list<array<string, mixed>>, todos: list<array{id: string, title: string, notes: string, dueDate: ?string, dueTime: ?string, durationMinutes: ?int, completedAt: ?string, position: int, source: string, messageId: ?string, threadId: ?string}>, deleted: list<array{type: string, id: string}>} */
        return $this->decodedResponse();
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
            'receivedAt' => new \DateTimeImmutable('-1 hour')->format(\DATE_ATOM),
            'messageId' => '<'.$sha.'@x>',
            'subject' => $subject,
            'from' => ['address' => 'anna@partner.example', 'name' => 'Anna'],
            'to' => [['address' => self::ME]],
            'snippet' => 'Hello',
        ], ...$override];
    }
}
