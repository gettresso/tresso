<?php

declare(strict_types=1);

namespace App\Tests\Functional;

use App\Security\Scope;
use PHPUnit\Framework\Attributes\DataProvider;
use Symfony\Component\Uid\Uuid;
use Symfony\Component\Uid\UuidV7;

/**
 * The reply queue: a reply written on any of Kim's devices waits until her relaying Mac claims it, and goes out once.
 * A claimed reply is never handed out again; one whose send could not be confirmed fails as `unconfirmed` and waits
 * for Kim's Try again. Results are final.
 */
final class ChatQueueTest extends DatabaseTestCase
{
    use AuthenticatesUsers;
    use ConnectsThirdPartyApps;
    use RelaysChats;
    use SeedsAccessTokens;
    use StoresChats;

    private string $chatId;

    protected function setUp(): void
    {
        parent::setUp();
        $this->setUpRelay();
        $this->relayMessages([self::waMessage('M1', 'Can you bring the drill on Saturday?')]);
        $this->chatId = $this->chatId();
    }

    public function testQueuesAReplyAndAnswersARepeatWithTheSameOne(): void
    {
        $id = self::newReplyId();
        $cursor = $this->delta(0)['cursor'];

        $reply = $this->queueReply($this->chatId, "  Perfect, I'll bring the drill on Saturday\n", $id);

        self::assertResponseStatusCodeSame(201);
        self::assertSame($id, $reply['id'] ?? null);
        self::assertSame($this->chatId, $reply['chatId'] ?? null);
        self::assertSame($this->accountId, $reply['chatAccountId'] ?? null);
        self::assertSame("Perfect, I'll bring the drill on Saturday", $reply['text'] ?? null, 'Trimmed.');
        self::assertSame('waiting', $reply['status'] ?? null);
        self::assertArrayHasKey('error', $reply);
        self::assertNull($reply['error']);
        self::assertArrayHasKey('sentAt', $reply);
        self::assertNull($reply['sentAt']);
        self::assertSame([$reply], $this->delta($cursor)['chatOutgoing'], 'The delta and the answer give one shape.');
        $sealed = $this->connection()->fetchOne('SELECT sealed_text FROM chat_outgoing');
        self::assertIsString($sealed);
        self::assertStringNotContainsString('drill', $sealed);

        $again = $this->queueReply($this->chatId, 'Something else entirely', $id);

        self::assertResponseStatusCodeSame(200);
        self::assertSame($reply, $again, 'The reply queued the first time, not a second one.');
        self::assertSame(1, $this->countRows('SELECT COUNT(*) FROM chat_outgoing'));
    }

    public function testAnIdTakenElsewhereIsAConflict(): void
    {
        $id = self::newReplyId();
        $this->queueReply($this->chatId, 'Hi', $id);
        $this->relayMessages([self::waMessage('N1', 'Hello', extra: ['chatJid' => self::OTHER_JID])], [['jid' => self::OTHER_JID, 'name' => 'Anna', 'kind' => 'direct']]);

        $this->queueReply($this->chatId(self::OTHER_JID), 'Hi', $id);
        self::assertResponseStatusCodeSame(409, 'The same id for another chat.');
        self::assertSame('id_taken', $this->decodedResponse()['code'] ?? null);

        $lisa = $this->userHeaders('lisa@example.test', ['mail:read', 'mail:write', 'mail:send'], 'desktop');
        $lisasAccount = $this->connectWhatsApp($lisa, self::OTHER_MAC);
        $this->relay('messages', ['chats' => [['jid' => self::JID, 'name' => 'Bram', 'kind' => 'direct']], 'messages' => [self::waMessage('L1', 'Hi Lisa')], 'deviceId' => self::OTHER_MAC], $lisa, $lisasAccount);
        self::assertResponseStatusCodeSame(200);
        $this->client->request('GET', '/api/v1/sync/changes?since=0&limit=2000', server: $lisa);
        $lisasChats = $this->decodedResponse()['chats'] ?? null;
        self::assertIsArray($lisasChats);
        self::assertIsArray($lisasChats[0] ?? null);
        self::assertIsString($lisasChats[0]['id'] ?? null);

        $this->queueReply($lisasChats[0]['id'], 'Hi', $id, $lisa);
        self::assertResponseStatusCodeSame(409, 'The same id from another user.');
        self::assertSame(1, $this->countRows('SELECT COUNT(*) FROM chat_outgoing'));
    }

    /**
     * @return iterable<string, array{array<string, mixed>, string}>
     */
    public static function invalidReplies(): iterable
    {
        yield 'no text' => [['text' => ''], 'text'];
        yield 'only whitespace' => [['text' => " \n\t "], 'text'];
        yield 'a text that is too long' => [['text' => str_repeat('a', 4097)], 'text'];
        yield 'a control character' => [['text' => "Hi\u{0007}"], 'text'];
        yield 'no id' => [['id' => ''], 'id'];
        yield 'an id that is not a UUIDv7' => [['id' => '6f1c0a5e-8d2b-4e4f-9a7b-1c2d3e4f5a6b'], 'id'];
        yield 'an id made long ago' => [['id' => new UuidV7(UuidV7::generate(new \DateTimeImmutable('-11 minutes')))->toRfc4122()], 'id'];
        yield 'an id made in the future' => [['id' => new UuidV7(UuidV7::generate(new \DateTimeImmutable('+10 minutes')))->toRfc4122()], 'id'];
    }

    /**
     * @param array<string, mixed> $change
     */
    #[DataProvider('invalidReplies')]
    public function testRefusesAnInvalidReply(array $change, string $path): void
    {
        $this->client->jsonRequest('POST', '/api/v1/chats/'.$this->chatId.'/outgoing', $change + ['id' => self::newReplyId(), 'text' => 'Hi'], $this->web);

        self::assertResponseStatusCodeSame(422);
        self::assertContains($path, $this->violationPaths());
        self::assertSame(0, $this->countRows('SELECT COUNT(*) FROM chat_outgoing'));
    }

    public function testATextOfTheLimitAfterTrimmingIsQueued(): void
    {
        $reply = $this->queueReply($this->chatId, ' '.str_repeat('a', 4096).' ');

        self::assertResponseStatusCodeSame(201);
        self::assertSame(str_repeat('a', 4096), $reply['text'] ?? null);
    }

    public function testALateRepeatStillGetsItsReply(): void
    {
        $id = new UuidV7(UuidV7::generate(new \DateTimeImmutable('-9 minutes')))->toRfc4122();
        $this->queueReply($this->chatId, 'Hi', $id);
        self::assertResponseStatusCodeSame(201);

        // As if an hour went by: the id is older than ten minutes now, and the reply it queued comes back all the same.
        $this->connection()->executeStatement('UPDATE chat_outgoing SET id = :late WHERE id = :id', ['late' => $late = new UuidV7(UuidV7::generate(new \DateTimeImmutable('-1 hour')))->toRfc4122(), 'id' => $id]);
        $this->queueReply($this->chatId, 'Hi', $late);

        self::assertResponseStatusCodeSame(200);
        self::assertSame(1, $this->countRows('SELECT COUNT(*) FROM chat_outgoing'));
    }

    public function testALeftOutChatTakesNoReply(): void
    {
        $this->client->request('PATCH', '/api/v1/chats/'.$this->chatId, server: $this->web + ['CONTENT_TYPE' => 'application/merge-patch+json'], content: '{"leftOut":true}');
        self::assertResponseIsSuccessful();

        $this->queueReply($this->chatId, 'Hi');

        self::assertResponseStatusCodeSame(422);
        self::assertSame(['chatId'], $this->violationPaths());
    }

    public function testTheRelayClaimsTheOldestFirstAndEachReplyOnce(): void
    {
        $first = $this->queuedId('One');
        $second = $this->queuedId('Two');

        $this->relay('outgoing/claim');
        self::assertResponseStatusCodeSame(200);
        self::assertSame(['id' => $first, 'chatId' => $this->chatId, 'chatJid' => self::JID, 'text' => 'One'], $this->decodedResponse());
        $this->relay('outgoing/claim');
        self::assertResponseStatusCodeSame(200);
        self::assertSame($second, $this->decodedResponse()['id'] ?? null, 'A claimed reply is not handed out again.');
        $this->relay('outgoing/claim');
        self::assertResponseStatusCodeSame(204);
        self::assertSame('', (string) $this->client->getResponse()->getContent());

        $replies = array_column($this->delta(0)['chatOutgoing'], null, 'id');
        self::assertSame('sending', $replies[$first]['status'] ?? null);
        self::assertIsString($replies[$first]['claimedAt'] ?? null);
    }

    public function testNothingToClaimIs204(): void
    {
        $this->relay('outgoing/claim');

        self::assertResponseStatusCodeSame(204);
    }

    public function testASentResultIsFinal(): void
    {
        $id = $this->claimedReply('Count me in!');
        $cursor = $this->delta(0)['cursor'];

        $this->relay('outgoing/'.$id.'/result', ['sent' => true]);

        self::assertResponseStatusCodeSame(200);
        $reply = $this->decodedResponse();
        self::assertSame('sent', $reply['status'] ?? null);
        self::assertIsString($reply['sentAt'] ?? null);
        $page = $this->delta($cursor);
        self::assertSame([$reply], $page['chatOutgoing']);
        self::assertSame($reply['sentAt'], $page['chats'][0]['lastMessageAt'] ?? null, 'The chat moves up with the reply.');

        $this->relay('outgoing/'.$id.'/result', ['sent' => true]);
        self::assertResponseStatusCodeSame(200, 'The same result again (its answer got lost).');
        self::assertSame($reply, $this->decodedResponse());

        $this->relay('outgoing/'.$id.'/result', ['sent' => false, 'error' => 'refused']);
        self::assertResponseStatusCodeSame(409);
        self::assertSame('result_final', $this->decodedResponse()['code'] ?? null);

        $this->relay('outgoing/claim');
        self::assertResponseStatusCodeSame(204, 'A sent reply is never claimed again.');
        $this->client->request('DELETE', '/api/v1/chat-outgoing/'.$id, server: $this->web);
        self::assertResponseStatusCodeSame(409);
        self::assertSame('already_going_out', $this->decodedResponse()['code'] ?? null);
        $this->client->jsonRequest('POST', '/api/v1/chat-outgoing/'.$id.'/retry', [], $this->web);
        self::assertResponseStatusCodeSame(409);
        self::assertSame('not_failed', $this->decodedResponse()['code'] ?? null);
    }

    /**
     * @return iterable<string, array{string}>
     */
    public static function failures(): iterable
    {
        foreach (['bridge_stopped', 'not_linked', 'refused', 'unconfirmed'] as $error) {
            yield $error => [$error];
        }
    }

    #[DataProvider('failures')]
    public function testAFailedResultWaitsForTryAgain(string $error): void
    {
        $id = $this->claimedReply('Count me in!');

        $this->relay('outgoing/'.$id.'/result', ['sent' => false, 'error' => $error]);

        self::assertResponseStatusCodeSame(200);
        self::assertSame('failed', $this->decodedResponse()['status'] ?? null);
        self::assertSame($error, $this->decodedResponse()['error'] ?? null);
        $this->relay('outgoing/'.$id.'/result', ['sent' => false, 'error' => $error]);
        self::assertResponseStatusCodeSame(200, 'The same result again.');
        $this->relay('outgoing/'.$id.'/result', ['sent' => true]);
        self::assertResponseStatusCodeSame(409, 'Another result is refused.');
        $this->relay('outgoing/claim');
        self::assertResponseStatusCodeSame(204, 'Nothing sends a failed reply again by itself.');

        $this->client->jsonRequest('POST', '/api/v1/chat-outgoing/'.$id.'/retry', [], $this->web);
        self::assertResponseStatusCodeSame(200);
        self::assertSame('waiting', $this->decodedResponse()['status'] ?? null);
        self::assertArrayHasKey('error', $this->decodedResponse());
        self::assertNull($this->decodedResponse()['error']);
        $this->relay('outgoing/claim');
        self::assertResponseStatusCodeSame(200);
        self::assertSame($id, $this->decodedResponse()['id'] ?? null, 'Try again hands it to the relay once more.');
    }

    public function testAResultNeedsAClaim(): void
    {
        $id = $this->queueReply($this->chatId, 'Hi')['id'] ?? null;
        self::assertIsString($id);

        $this->relay('outgoing/'.$id.'/result', ['sent' => true]);

        self::assertResponseStatusCodeSame(409);
        self::assertSame('result_final', $this->decodedResponse()['code'] ?? null);
        $this->relay('outgoing/'.Uuid::v7()->toRfc4122().'/result', ['sent' => true]);
        self::assertResponseStatusCodeSame(404);
    }

    /**
     * @return iterable<string, array{array<string, mixed>}>
     */
    public static function invalidResults(): iterable
    {
        yield 'sent with an error' => [['sent' => true, 'error' => 'refused']];
        yield 'not sent without an error' => [['sent' => false]];
        yield 'no outcome' => [[]];
    }

    /**
     * @param array<string, mixed> $result
     */
    #[DataProvider('invalidResults')]
    public function testRefusesAnInvalidResult(array $result): void
    {
        $id = $this->claimedReply('Hi');

        $this->relay('outgoing/'.$id.'/result', $result);

        self::assertResponseStatusCodeSame(422);
        self::assertSame('sending', $this->delta(0)['chatOutgoing'][0]['status'] ?? null);
    }

    public function testTheSweepFailsAReplyWhoseSendCouldNotBeConfirmed(): void
    {
        $stuck = $this->claimedReply('Stuck');
        $fresh = $this->claimedReply('Fresh');
        $this->connection()->executeStatement("UPDATE chat_outgoing SET claimed_at = claimed_at - INTERVAL '6 minutes' WHERE id = :id", ['id' => $stuck]);
        $cursor = $this->delta(0)['cursor'];

        self::assertSame(['offline' => 0, 'unconfirmed' => 1], $this->sweep());

        $page = $this->delta($cursor);
        self::assertSame([$stuck], array_column($page['chatOutgoing'], 'id'), 'A change for clients.');
        self::assertSame('failed', $page['chatOutgoing'][0]['status'] ?? null);
        self::assertSame('unconfirmed', $page['chatOutgoing'][0]['error'] ?? null);
        $this->relay('outgoing/claim');
        self::assertResponseStatusCodeSame(204, 'It may have gone out: it is never handed out again by itself.');
        $this->relay('outgoing/'.$fresh.'/result', ['sent' => true]);
        self::assertResponseStatusCodeSame(200, 'A reply within its lease is left alone.');
        $this->relay('outgoing/'.$stuck.'/result', ['sent' => true]);
        self::assertResponseStatusCodeSame(409, 'A result after the lease is not taken.');
        self::assertSame(['offline' => 0, 'unconfirmed' => 0], $this->sweep());
    }

    public function testCancelsAReplyThatWaitsOrFailed(): void
    {
        $waiting = $this->queueReply($this->chatId, 'Never mind')['id'] ?? null;
        self::assertIsString($waiting);
        $cursor = $this->delta(0)['cursor'];

        $this->client->request('DELETE', '/api/v1/chat-outgoing/'.$waiting, server: $this->web);

        self::assertResponseStatusCodeSame(204);
        self::assertSame(0, $this->countRows('SELECT COUNT(*) FROM chat_outgoing'));
        self::assertSame([['type' => 'chatOutgoing', 'id' => $waiting]], $this->delta($cursor)['deleted']);

        $failed = $this->claimedReply('Hi');
        $this->relay('outgoing/'.$failed.'/result', ['sent' => false, 'error' => 'not_linked']);
        $this->client->request('DELETE', '/api/v1/chat-outgoing/'.$failed, server: $this->web);
        self::assertResponseStatusCodeSame(204);

        $sending = $this->claimedReply('On its way');
        $this->client->request('DELETE', '/api/v1/chat-outgoing/'.$sending, server: $this->web);
        self::assertResponseStatusCodeSame(409);
        self::assertSame('already_going_out', $this->decodedResponse()['code'] ?? null);
        $this->client->jsonRequest('POST', '/api/v1/chat-outgoing/'.$sending.'/retry', [], $this->web);
        self::assertResponseStatusCodeSame(409);
        self::assertSame('not_failed', $this->decodedResponse()['code'] ?? null);
    }

    /**
     * Every way a reply ends reaches a device that holds it as waiting: sent and failed (also by the sweep) as the row
     * with its new state, cancelled as a removal of the reply.
     */
    public function testADeviceThatHoldsAWaitingReplySeesHowItEnds(): void
    {
        $sent = $this->queuedId('Sent');
        $refused = $this->queuedId('Refused');
        $expired = $this->queuedId('Expired');
        $cancelled = $this->queuedId('Cancelled');
        $page = $this->delta(0);
        self::assertSame(['waiting', 'waiting', 'waiting', 'waiting'], array_column($page['chatOutgoing'], 'status'));
        $cursor = $page['cursor'];

        foreach ([$sent, $refused, $expired] as $id) {
            $this->relay('outgoing/claim');
            self::assertSame($id, $this->decodedResponse()['id'] ?? null);
        }
        $this->relay('outgoing/'.$sent.'/result', ['sent' => true]);
        $page = $this->delta($cursor);
        $cursor = $page['cursor'];
        self::assertSame('sent', array_column($page['chatOutgoing'], 'status', 'id')[$sent] ?? null);

        $this->relay('outgoing/'.$refused.'/result', ['sent' => false, 'error' => 'refused']);
        $page = $this->delta($cursor);
        $cursor = $page['cursor'];
        self::assertSame([['id' => $refused, 'status' => 'failed', 'error' => 'refused']], array_map(static fn (array $row): array => ['id' => $row['id'] ?? null, 'status' => $row['status'] ?? null, 'error' => $row['error'] ?? null], $page['chatOutgoing']));

        $this->connection()->executeStatement("UPDATE chat_outgoing SET claimed_at = claimed_at - INTERVAL '6 minutes' WHERE id = :id", ['id' => $expired]);
        $this->sweep();
        $page = $this->delta($cursor);
        $cursor = $page['cursor'];
        self::assertSame([['id' => $expired, 'status' => 'failed', 'error' => 'unconfirmed']], array_map(static fn (array $row): array => ['id' => $row['id'] ?? null, 'status' => $row['status'] ?? null, 'error' => $row['error'] ?? null], $page['chatOutgoing']));

        $this->client->request('DELETE', '/api/v1/chat-outgoing/'.$cancelled, server: $this->web);
        self::assertResponseStatusCodeSame(204);
        $page = $this->delta($cursor);
        self::assertSame([], $page['chatOutgoing']);
        self::assertSame([['type' => 'chatOutgoing', 'id' => $cancelled]], $page['deleted']);
    }

    public function testAnotherUserReachesNoneOfIt(): void
    {
        $waiting = $this->queueReply($this->chatId, 'Hi')['id'] ?? null;
        self::assertIsString($waiting);
        $lisa = $this->userHeaders('lisa@example.test', ['mail:read', 'mail:write', 'mail:send']);

        $this->queueReply($this->chatId, 'Let me in', headers: $lisa);
        self::assertResponseStatusCodeSame(404);
        $this->client->request('DELETE', '/api/v1/chat-outgoing/'.$waiting, server: $lisa);
        self::assertResponseStatusCodeSame(404);
        $this->client->jsonRequest('POST', '/api/v1/chat-outgoing/'.$waiting.'/retry', [], $lisa);
        self::assertResponseStatusCodeSame(404);
        self::assertSame(1, $this->countRows('SELECT COUNT(*) FROM chat_outgoing'));
    }

    /**
     * @return iterable<string, array{string, list<string>}>
     */
    public static function ourAppsThatSend(): iterable
    {
        yield 'the web app' => ['web', ['mail:send']];
        yield 'the desktop app' => ['desktop', ['mail:send']];
        yield 'the mobile app' => ['mobile', ['mail:send']];
    }

    /**
     * @param list<string> $scopes
     */
    #[DataProvider('ourAppsThatSend')]
    public function testOurAppsQueueWithMailSend(string $client, array $scopes): void
    {
        $this->queueReply($this->chatId, 'Hi', headers: $this->userHeaders('kim@example.test', $scopes, $client));

        self::assertResponseStatusCodeSame(201);
    }

    public function testOurAppsWithoutMailSendDoNotQueue(): void
    {
        $this->queueReply($this->chatId, 'Hi', headers: $this->userHeaders('kim@example.test', ['mail:read', 'mail:write']));

        self::assertResponseStatusCodeSame(403);
    }

    public function testChatReadAloneDoesNotQueueCancelOrRetry(): void
    {
        $waiting = $this->queueReply($this->chatId, 'Hi')['id'] ?? null;
        self::assertIsString($waiting);
        $headers = $this->seededThirdPartyHeaders('kim@example.test', ['chat:read']);

        $this->queueReply($this->chatId, 'From a tool', headers: $headers);
        self::assertResponseStatusCodeSame(403);
        $this->client->request('DELETE', '/api/v1/chat-outgoing/'.$waiting, server: $headers);
        self::assertResponseStatusCodeSame(403);
        $this->client->jsonRequest('POST', '/api/v1/chat-outgoing/'.$waiting.'/retry', [], $headers);
        self::assertResponseStatusCodeSame(403);
        self::assertSame(1, $this->countRows('SELECT COUNT(*) FROM chat_outgoing'));
    }

    public function testChatSendQueuesAReply(): void
    {
        $this->queueReply($this->chatId, 'From a tool', headers: $this->seededThirdPartyHeaders('kim@example.test', ['chat:send']));

        self::assertResponseStatusCodeSame(201);
    }

    public function testCallersWithoutAChatScopeNeverQueue(): void
    {
        $this->queueReply($this->chatId, 'Hi', headers: $this->personalAccessTokenHeaders('kim@example.test', array_map(static fn (Scope $scope): string => $scope->value, Scope::personalAccessTokenScopes())));
        self::assertResponseStatusCodeSame(403);
        $this->queueReply($this->chatId, 'Hi', headers: $this->thirdPartyHeaders('kim@example.test', array_map(static fn (Scope $scope): string => $scope->value, Scope::thirdPartyAppScopes())));
        self::assertResponseStatusCodeSame(403);
        $this->client->jsonRequest('POST', '/api/v1/chats/'.$this->chatId.'/outgoing', ['id' => self::newReplyId(), 'text' => 'Hi'], ['HTTP_ACCEPT' => 'application/json']);
        self::assertResponseStatusCodeSame(401);
        self::assertSame(0, $this->countRows('SELECT COUNT(*) FROM chat_outgoing'));
    }

    public function testQueueingIsLimitedPerUserButARepeatIsNot(): void
    {
        // The test limit is 8 replies in 10 minutes.
        $first = self::newReplyId();
        $this->queueReply($this->chatId, 'Reply 1', $first);
        for ($i = 2; $i <= 8; ++$i) {
            $this->queueReply($this->chatId, 'Reply '.$i);
            self::assertResponseStatusCodeSame(201);
        }

        $this->queueReply($this->chatId, 'Reply 9');
        self::assertResponseStatusCodeSame(429);
        $this->queueReply($this->chatId, 'Reply 1', $first);
        self::assertResponseStatusCodeSame(200, 'A repeat queues nothing, so it is not counted.');
        self::assertSame(8, $this->countRows('SELECT COUNT(*) FROM chat_outgoing'));
    }

    /** The id of a reply Kim queued. */
    private function queuedId(string $text): string
    {
        $id = $this->queueReply($this->chatId, $text)['id'] ?? null;
        self::assertResponseStatusCodeSame(201);
        self::assertIsString($id);

        return $id;
    }

    /** A reply Kim queued, claimed by her Mac. */
    private function claimedReply(string $text): string
    {
        $id = $this->queueReply($this->chatId, $text)['id'] ?? null;
        self::assertIsString($id);
        $this->relay('outgoing/claim');
        self::assertResponseStatusCodeSame(200);
        self::assertSame($id, $this->decodedResponse()['id'] ?? null);

        return $id;
    }
}
