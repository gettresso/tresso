<?php

declare(strict_types=1);

namespace App\Tests\Functional;

use App\Chat\PurgeCancelledReplies;
use App\Chat\PurgeCancelledRepliesHandler;
use App\Chat\SweepChatMedia;
use App\Chat\SweepChatMediaHandler;
use App\Entity\Chat;
use App\Security\Scope;
use Doctrine\ORM\EntityManagerInterface;
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
        yield 'an id made long ago' => [['id' => self::uuidV7At('-11 minutes')], 'id'];
        yield 'an id made in the future' => [['id' => self::uuidV7At('+10 minutes')], 'id'];
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
        // Queued an hour ago, as the reply's id says: the request comes again only now.
        $late = self::uuidV7At('-1 hour');
        $this->chatEntityManager()->wrapInTransaction(function (EntityManagerInterface $entityManager) use ($late): void {
            $chat = $entityManager->find(Chat::class, Uuid::fromString($this->chatId));
            self::assertInstanceOf(Chat::class, $chat);
            $entityManager->persist($this->chatFields()->newOutgoing(Uuid::fromString($late), $chat, 'Hi', new \DateTimeImmutable('-1 hour')));
        });
        $this->chatEntityManager()->clear();

        $reply = $this->queueReply($this->chatId, 'Hi', $late);

        self::assertResponseStatusCodeSame(200, 'The reply it queued comes back, though its id is older than ten minutes now.');
        self::assertSame($late, $reply['id'] ?? null);
        self::assertSame(1, $this->countRows('SELECT COUNT(*) FROM chat_outgoing'));
    }

    /**
     * A UUIDv7 made at $when, built by hand: Symfony's generator keeps its last time, so asking it for a time ahead
     * would push every id made after it ahead too.
     */
    private static function uuidV7At(string $when): string
    {
        $hex = str_pad(dechex((int) new \DateTimeImmutable($when)->format('Uv')), 12, '0', \STR_PAD_LEFT).'7'.bin2hex(random_bytes(10));
        $hex[16] = dechex(8 | (hexdec($hex[16]) & 3));

        return Uuid::fromString(vsprintf('%s-%s-%s-%s-%s', sscanf(substr($hex, 0, 32), '%8s%4s%4s%4s%12s') ?? []))->toRfc4122();
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
        $token = $this->tokenOf($first);
        self::assertIsString($token);
        self::assertSame(32, \strlen($token));
        self::assertSame(['id' => $first, 'chatId' => $this->chatId, 'chatJid' => self::JID, 'text' => 'One', 'claimToken' => $token, 'file' => null], $this->decodedResponse());
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

        $this->report($id, ['sent' => true]);

        self::assertResponseStatusCodeSame(200);
        $reply = $this->decodedResponse();
        self::assertSame('sent', $reply['status'] ?? null);
        self::assertIsString($reply['sentAt'] ?? null);
        $page = $this->delta($cursor);
        self::assertSame([$reply], $page['chatOutgoing']);
        self::assertSame($reply['sentAt'], $page['chats'][0]['lastMessageAt'] ?? null, 'The chat moves up with the reply.');

        $this->report($id, ['sent' => true]);
        self::assertResponseStatusCodeSame(200, 'The same result again (its answer got lost).');
        self::assertSame($reply, $this->decodedResponse());

        $this->report($id, ['sent' => false, 'error' => 'refused']);
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

        $this->report($id, ['sent' => false, 'error' => $error]);

        self::assertResponseStatusCodeSame(200);
        self::assertSame('failed', $this->decodedResponse()['status'] ?? null);
        self::assertSame($error, $this->decodedResponse()['error'] ?? null);
        $this->report($id, ['sent' => false, 'error' => $error]);
        self::assertResponseStatusCodeSame(200, 'The same result again.');
        // After `unconfirmed` only the claim's own answer is taken (see testTheSweepFailsAReplyWhoseSendCouldNotBeConfirmed).
        $this->report($id, ['sent' => 'unconfirmed' === $error ? false : true] + ('unconfirmed' === $error ? ['error' => 'refused', 'claimToken' => 'another claim'] : []));
        self::assertResponseStatusCodeSame(409, 'Another result is refused.');
        $this->relay('outgoing/claim');
        self::assertResponseStatusCodeSame(204, 'Nothing sends a failed reply again by itself.');
        if ('unconfirmed' === $error) {
            // Try again waits until the claim's lease is over: the relay may still be sending it.
            $this->client->jsonRequest('POST', '/api/v1/chat-outgoing/'.$id.'/retry', [], $this->web);
            self::assertResponseStatusCodeSame(409);
            self::assertSame('still_sending', $this->decodedResponse()['code'] ?? null);
            $this->connection()->executeStatement("UPDATE chat_outgoing SET claimed_at = NOW() - INTERVAL '6 minutes' WHERE id = :id", ['id' => $id]);
        }

        $this->client->jsonRequest('POST', '/api/v1/chat-outgoing/'.$id.'/retry', [], $this->web);
        self::assertResponseStatusCodeSame(200);
        self::assertSame('waiting', $this->decodedResponse()['status'] ?? null);
        self::assertArrayHasKey('error', $this->decodedResponse());
        self::assertNull($this->decodedResponse()['error']);
        $this->relay('outgoing/claim');
        self::assertResponseStatusCodeSame(200);
        self::assertSame($id, $this->decodedResponse()['id'] ?? null, 'Try again hands it to the relay once more.');
    }

    public function testASendTheRelayCouldNotConfirmMayStillBeReportedSent(): void
    {
        $id = $this->claimedReply('Count me in!');
        $this->report($id, ['sent' => false, 'error' => 'unconfirmed']);
        self::assertResponseStatusCodeSame(200);

        $this->report($id, ['sent' => true]);

        self::assertResponseStatusCodeSame(200, 'It went out after all: the truth wins.');
        self::assertSame('sent', $this->decodedResponse()['status'] ?? null);
    }

    public function testAResultNeedsAClaim(): void
    {
        $id = $this->queueReply($this->chatId, 'Hi')['id'] ?? null;
        self::assertIsString($id);

        $this->report($id, ['sent' => true]);

        self::assertResponseStatusCodeSame(409);
        self::assertSame('result_final', $this->decodedResponse()['code'] ?? null);
        $this->report(Uuid::v7()->toRfc4122(), ['sent' => true]);
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
        yield 'no claim' => [['sent' => true, 'claimToken' => '']];
    }

    /**
     * @param array<string, mixed> $result
     */
    #[DataProvider('invalidResults')]
    public function testRefusesAnInvalidResult(array $result): void
    {
        $id = $this->claimedReply('Hi');

        $this->report($id, $result);

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
        $this->report($fresh, ['sent' => true]);
        self::assertResponseStatusCodeSame(200, 'A reply within its lease is left alone.');
        self::assertSame(['offline' => 0, 'unconfirmed' => 0], $this->sweep());
        $this->report($stuck, ['sent' => true]);
        self::assertResponseStatusCodeSame(200, 'It went out after all: the truth wins, and Try again cannot send it twice.');
        self::assertSame('sent', $this->decodedResponse()['status'] ?? null);
        $this->report($stuck, ['sent' => true]);
        self::assertResponseStatusCodeSame(200);

        // The claim's own definite failure, late, replaces `unconfirmed` too: nothing went out, and the user sees why.
        $late = $this->claimedReply('Late');
        $this->connection()->executeStatement("UPDATE chat_outgoing SET claimed_at = NOW() - INTERVAL '6 minutes' WHERE id = :id", ['id' => $late]);
        self::assertSame(['offline' => 0, 'unconfirmed' => 1], $this->sweep());
        $this->report($late, ['sent' => false, 'error' => 'refused']);
        self::assertResponseStatusCodeSame(200);
        self::assertSame(['failed', 'refused'], [$this->decodedResponse()['status'] ?? null, $this->decodedResponse()['error'] ?? null]);
        $this->report($late, ['sent' => true]);
        self::assertResponseStatusCodeSame(409, 'Then it is final.');
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
        $this->report($failed, ['sent' => false, 'error' => 'not_linked']);
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

    public function testACancelThatOvertakesItsQueueingIsKept(): void
    {
        $id = self::newReplyId();
        $cursor = $this->delta(0)['cursor'];

        $this->client->request('DELETE', '/api/v1/chat-outgoing/'.$id, server: $this->web);
        self::assertResponseStatusCodeSame(204, 'An id a new reply could have: the cancel is recorded.');
        self::assertSame([['type' => 'chatOutgoing', 'id' => $id]], $this->delta($cursor)['deleted']);
        $this->client->request('DELETE', '/api/v1/chat-outgoing/'.$id, server: $this->web);
        self::assertResponseStatusCodeSame(204, 'Again: the same.');

        $this->queueReply($this->chatId, 'Too late', $id);
        self::assertResponseStatusCodeSame(409);
        self::assertSame('cancelled', $this->decodedResponse()['code'] ?? null);
        self::assertSame(0, $this->countRows('SELECT COUNT(*) FROM chat_outgoing'), 'Nothing goes out.');

        // In the other order the reply is there and goes as before.
        $queued = self::newReplyId();
        $this->queueReply($this->chatId, 'In time', $queued);
        self::assertResponseStatusCodeSame(201);
        $this->client->request('DELETE', '/api/v1/chat-outgoing/'.$queued, server: $this->web);
        self::assertResponseStatusCodeSame(204);
        $this->relay('outgoing/claim');
        self::assertResponseStatusCodeSame(204);
    }

    public function testACancelOfAnIdNoNewReplyCouldHaveIsNotFound(): void
    {
        $old = new UuidV7(UuidV7::generate(new \DateTimeImmutable('-11 minutes')))->toRfc4122();
        $this->client->request('DELETE', '/api/v1/chat-outgoing/'.$old, server: $this->web);
        self::assertResponseStatusCodeSame(404);
        $this->client->request('DELETE', '/api/v1/chat-outgoing/'.Uuid::v4()->toRfc4122(), server: $this->web);
        self::assertResponseStatusCodeSame(404);

        $kims = $this->queueReply($this->chatId, 'Mine')['id'] ?? null;
        self::assertIsString($kims);
        $this->createUser('ann@example.test', 'Ann');
        $this->client->request('DELETE', '/api/v1/chat-outgoing/'.$kims, server: $this->userHeaders('ann@example.test', ['mail:read', 'mail:write', 'mail:send']));
        self::assertResponseStatusCodeSame(404, 'Another user\'s reply is not found, and stays.');
        self::assertSame(1, $this->countRows('SELECT COUNT(*) FROM chat_outgoing'));
        self::assertSame(0, $this->countRows("SELECT COUNT(*) FROM sync_tombstone WHERE entity_type = 'chatOutgoing'"));
    }

    public function testCancelsOfUnseenRepliesAreLimited(): void
    {
        for ($i = 0; $i < 12; ++$i) {
            $this->client->request('DELETE', '/api/v1/chat-outgoing/'.self::newReplyId(), server: $this->web);
            self::assertResponseStatusCodeSame(204);
        }

        $this->client->request('DELETE', '/api/v1/chat-outgoing/'.self::newReplyId(), server: $this->web);

        self::assertResponseStatusCodeSame(429);
    }

    public function testACancelledReplyThatWentOutAfterAllShowsAsSent(): void
    {
        $id = $this->unconfirmedReply('Maybe out');
        $cursor = $this->delta(0)['cursor'];

        $this->client->request('DELETE', '/api/v1/chat-outgoing/'.$id, server: $this->web);
        self::assertResponseStatusCodeSame(204);
        self::assertSame([['type' => 'chatOutgoing', 'id' => $id]], $this->delta($cursor)['deleted']);
        self::assertSame('cancelled', $this->connection()->fetchOne('SELECT status FROM chat_outgoing WHERE id = :id', ['id' => $id]));
        $this->relay('outgoing/claim');
        self::assertResponseStatusCodeSame(204, 'Never handed out again.');
        $this->queueReply($this->chatId, 'Maybe out', $id);
        self::assertResponseStatusCodeSame(409);
        self::assertSame('cancelled', $this->decodedResponse()['code'] ?? null);
        $this->client->jsonRequest('POST', '/api/v1/chat-outgoing/'.$id.'/retry', [], $this->web);
        self::assertResponseStatusCodeSame(409);
        $cursor = $this->delta(0)['cursor'];

        $this->report($id, ['sent' => true, 'claimToken' => 'another claim']);
        self::assertResponseStatusCodeSame(409, 'Only its own claim.');
        $this->report($id, ['sent' => true]);

        self::assertResponseStatusCodeSame(200);
        self::assertSame('sent', $this->decodedResponse()['status'] ?? null);
        self::assertSame([$id], array_column($this->delta($cursor)['chatOutgoing'], 'id'), 'Every device shows it again, as sent.');
    }

    public function testACancelledReplyStaysCancelledWithoutItsRelaysWordOrWithALateFailure(): void
    {
        $quiet = $this->unconfirmedReply('Quiet');
        $this->client->request('DELETE', '/api/v1/chat-outgoing/'.$quiet, server: $this->web);
        self::assertResponseStatusCodeSame(204);
        self::assertSame([], $this->delta(0)['chatOutgoing'], 'Out of every list.');

        $failed = $this->unconfirmedReply('Not out');
        $this->client->request('DELETE', '/api/v1/chat-outgoing/'.$failed, server: $this->web);
        $cursor = $this->delta(0)['cursor'];
        $this->report($failed, ['sent' => false, 'error' => 'refused']);

        self::assertResponseStatusCodeSame(200);
        self::assertSame('cancelled', $this->decodedResponse()['status'] ?? null);
        self::assertSame([], $this->delta($cursor)['chatOutgoing']);
        self::assertSame(['cancelled', 'cancelled'], $this->connection()->fetchFirstColumn('SELECT status FROM chat_outgoing ORDER BY id'));
    }

    public function testACancelledReplyGoesAfterThirtyDaysAndItsIdStaysRefused(): void
    {
        $old = $this->unconfirmedReply('Long ago');
        $recent = $this->unconfirmedReply('Lately');
        foreach ([$old, $recent] as $id) {
            $this->client->request('DELETE', '/api/v1/chat-outgoing/'.$id, server: $this->web);
            self::assertResponseStatusCodeSame(204);
        }
        $token = $this->tokenOf($old);
        self::assertNotNull($token);
        $this->connection()->executeStatement("UPDATE chat_outgoing SET claimed_at = NOW() - INTERVAL '31 days' WHERE id = :id", ['id' => $old]);
        $tombstones = $this->countRows("SELECT COUNT(*) FROM sync_tombstone WHERE entity_type = 'chatOutgoing'");

        static::getContainer()->get(SweepChatMediaHandler::class)(new SweepChatMedia());
        self::assertCount(2, $this->connection()->fetchFirstColumn('SELECT id FROM chat_outgoing'), 'Not by the sweep every ten minutes.');
        static::getContainer()->get(PurgeCancelledRepliesHandler::class)(new PurgeCancelledReplies());

        self::assertSame([$recent], $this->connection()->fetchFirstColumn('SELECT id FROM chat_outgoing'), 'Its text and claim are gone; the recent one stays.');
        self::assertSame($tombstones, $this->countRows("SELECT COUNT(*) FROM sync_tombstone WHERE entity_type = 'chatOutgoing'"), 'Its removal stays.');
        $this->queueReply($this->chatId, 'Long ago', $old);
        self::assertResponseStatusCodeSame(409);
        self::assertSame('cancelled', $this->decodedResponse()['code'] ?? null);
        // A relay's answer after that finds nothing to record: not found, which the relay takes as final.
        $this->report($old, ['sent' => true, 'claimToken' => $token]);
        self::assertResponseStatusCodeSame(404);
        self::assertSame(0, $this->countRows('SELECT COUNT(*) FROM chat_outgoing WHERE id = '."'".$old."'"));
    }

    /** A reply its relay claimed and said `unconfirmed` for: its claim is still on it. */
    private function unconfirmedReply(string $text): string
    {
        $id = $this->claimedReply($text);
        $this->report($id, ['sent' => false, 'error' => 'unconfirmed']);
        self::assertResponseStatusCodeSame(200);
        self::assertNotNull($this->tokenOf($id));

        return $id;
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
        $this->report($sent, ['sent' => true]);
        $page = $this->delta($cursor);
        $cursor = $page['cursor'];
        self::assertSame('sent', array_column($page['chatOutgoing'], 'status', 'id')[$sent] ?? null);

        $this->report($refused, ['sent' => false, 'error' => 'refused']);
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

    public function testACancelledReplyIsNeverQueuedAgain(): void
    {
        $id = self::newReplyId();
        $this->queueReply($this->chatId, 'Never mind', $id);
        self::assertResponseStatusCodeSame(201);
        $this->client->request('DELETE', '/api/v1/chat-outgoing/'.$id, server: $this->web);
        self::assertResponseStatusCodeSame(204);

        // The answer to the first request got lost, and the client sends it again.
        $this->queueReply($this->chatId, 'Never mind', $id);

        self::assertResponseStatusCodeSame(409);
        self::assertSame('cancelled', $this->decodedResponse()['code'] ?? null);
        self::assertSame(0, $this->countRows('SELECT COUNT(*) FROM chat_outgoing'));
        $this->relay('outgoing/claim');
        self::assertResponseStatusCodeSame(204, 'Nothing goes out.');
    }

    public function testALateRepeatOfACancelledReplyIsRefusedAsCancelledNotAsTooOld(): void
    {
        // Queued an hour ago, its answer lost; the user cancelled it on another device since.
        $late = self::uuidV7At('-1 hour');
        $this->chatEntityManager()->wrapInTransaction(function (EntityManagerInterface $entityManager) use ($late): void {
            $chat = $entityManager->find(Chat::class, Uuid::fromString($this->chatId));
            self::assertInstanceOf(Chat::class, $chat);
            $entityManager->persist($this->chatFields()->newOutgoing(Uuid::fromString($late), $chat, 'Never mind', new \DateTimeImmutable('-1 hour')));
        });
        $this->chatEntityManager()->clear();
        $this->client->request('DELETE', '/api/v1/chat-outgoing/'.$late, server: $this->web);
        self::assertResponseStatusCodeSame(204);

        $this->queueReply($this->chatId, 'Never mind', $late);

        self::assertResponseStatusCodeSame(409, 'Not 422 on the id: the client must not make a new id and send it again.');
        self::assertSame('cancelled', $this->decodedResponse()['code'] ?? null);
        self::assertSame(0, $this->countRows('SELECT COUNT(*) FROM chat_outgoing'));
    }

    public function testTheRepliesOfALeftOutChatAreNeverQueuedAgain(): void
    {
        $id = self::newReplyId();
        $this->queueReply($this->chatId, 'Count me in!', $id);
        self::assertResponseStatusCodeSame(201);
        foreach (['{"leftOut":true}', '{"leftOut":false}'] as $change) {
            $this->client->request('PATCH', '/api/v1/chats/'.$this->chatId, server: $this->web + ['CONTENT_TYPE' => 'application/merge-patch+json'], content: $change);
            self::assertResponseIsSuccessful();
        }

        $this->queueReply($this->chatId, 'Count me in!', $id);

        self::assertResponseStatusCodeSame(409);
        self::assertSame('cancelled', $this->decodedResponse()['code'] ?? null);
        self::assertSame(0, $this->countRows('SELECT COUNT(*) FROM chat_outgoing'));
    }

    public function testAResultOfAnEarlierClaimIsRefused(): void
    {
        $id = $this->claimedReply('Hi');
        $earlier = $this->tokenOf($id);
        self::assertIsString($earlier);
        $this->report($id, ['sent' => false, 'error' => 'bridge_stopped']);
        self::assertResponseStatusCodeSame(200);
        self::assertNull($this->tokenOf($id), 'A final result ends the claim.');
        $this->client->jsonRequest('POST', '/api/v1/chat-outgoing/'.$id.'/retry', [], $this->web);
        self::assertResponseStatusCodeSame(200);
        $this->relay('outgoing/claim');
        self::assertSame($id, $this->decodedResponse()['id'] ?? null);
        self::assertNotSame($earlier, $this->decodedResponse()['claimToken'] ?? null);

        $this->report($id, ['sent' => true, 'claimToken' => $earlier]);

        self::assertResponseStatusCodeSame(409);
        self::assertSame('result_final', $this->decodedResponse()['code'] ?? null);
        self::assertSame('sending', $this->delta(0)['chatOutgoing'][0]['status'] ?? null, 'The claim that holds it now decides.');
        $this->report($id, ['sent' => true]);
        self::assertResponseStatusCodeSame(200);
    }

    public function testAWrongTokenIsRefused(): void
    {
        $id = $this->claimedReply('Hi');

        $this->report($id, ['sent' => true, 'claimToken' => str_repeat('0', 32)]);

        self::assertResponseStatusCodeSame(409);
        self::assertSame('result_final', $this->decodedResponse()['code'] ?? null);
        self::assertSame('sending', $this->delta(0)['chatOutgoing'][0]['status'] ?? null);
    }

    public function testTheRightTokenFromAnotherDesktopIsRefused(): void
    {
        $id = $this->claimedReply('Hi');

        $this->report($id, ['sent' => true, 'deviceId' => self::OTHER_MAC]);

        self::assertResponseStatusCodeSame(409, 'Only the device that claimed it, with its token.');
        self::assertSame('not_the_relay', $this->decodedResponse()['code'] ?? null);
        self::assertSame('sending', $this->delta(0)['chatOutgoing'][0]['status'] ?? null);
    }

    public function testTheClaimNeverReachesClients(): void
    {
        $id = $this->claimedReply('Hi');
        $token = $this->tokenOf($id);
        self::assertIsString($token);
        $answers = [];

        $answers[] = json_encode($this->delta(0), \JSON_THROW_ON_ERROR);
        $this->report($id, ['sent' => false, 'error' => 'unconfirmed']);
        $answers[] = (string) $this->client->getResponse()->getContent();
        $this->client->jsonRequest('POST', '/api/v1/chat-outgoing/'.$id.'/retry', [], $this->web);
        $answers[] = (string) $this->client->getResponse()->getContent();
        $answers[] = json_encode($this->queueReply($this->chatId, 'Another'), \JSON_THROW_ON_ERROR);
        $answers[] = json_encode($this->delta(0), \JSON_THROW_ON_ERROR);

        foreach ($answers as $answer) {
            self::assertStringNotContainsString($token, $answer);
            self::assertStringNotContainsString('claimToken', $answer);
            self::assertStringNotContainsString('claimedBy', $answer);
        }
    }

    public function testADesktopThatNoLongerRelaysMayStillSayItsReplyWentOut(): void
    {
        $sent = $this->claimedReply('Sent');
        $failed = $this->claimedReply('Failed');
        $this->connectWhatsApp($this->userHeaders('kim@example.test', ['mail:read', 'mail:write'], 'desktop'), self::OTHER_MAC);

        $this->report($failed, ['sent' => false, 'error' => 'refused']);
        self::assertResponseStatusCodeSame(409);
        self::assertSame('not_the_relay', $this->decodedResponse()['code'] ?? null, 'Only that it went out.');
        $this->report($sent, ['sent' => true, 'claimToken' => str_repeat('0', 32)]);
        self::assertResponseStatusCodeSame(409);
        self::assertSame('not_the_relay', $this->decodedResponse()['code'] ?? null, 'Only with its own claim\'s token.');

        $this->report($sent, ['sent' => true]);

        self::assertResponseStatusCodeSame(200);
        self::assertSame('sent', $this->decodedResponse()['status'] ?? null);
        $replies = array_column($this->delta(0)['chatOutgoing'], 'status', 'id');
        self::assertSame('sending', $replies[$failed] ?? null);
    }

    public function testAnotherUserReachesNoneOfIt(): void
    {
        $waiting = $this->queueReply($this->chatId, 'Hi')['id'] ?? null;
        self::assertIsString($waiting);
        $lisa = $this->userHeaders('lisa@example.test', ['mail:read', 'mail:write', 'mail:send']);

        $this->queueReply($this->chatId, 'Let me in', headers: $lisa);
        self::assertResponseStatusCodeSame(404);
        $this->queueReply($this->chatId, 'Let me in', $waiting, $lisa);
        self::assertResponseStatusCodeSame(404, 'The chat is looked up first: Kim\'s reply id tells Lisa nothing.');
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

    /**
     * Cancelling its own waiting reply is harmless, so chat:send may; trying again is not (a reply that failed as
     * unconfirmed may have gone out), so it stays with the user in our own apps.
     */
    public function testChatSendCancelsButOnlyOurAppsTryAgain(): void
    {
        $headers = $this->seededThirdPartyHeaders('kim@example.test', ['chat:send']);
        $waiting = $this->queueReply($this->chatId, 'From a tool', headers: $headers)['id'] ?? null;
        self::assertIsString($waiting);
        $this->client->request('DELETE', '/api/v1/chat-outgoing/'.$waiting, server: $headers);
        self::assertResponseStatusCodeSame(204);

        $failed = $this->queueReply($this->chatId, 'From a tool too', headers: $headers)['id'] ?? null;
        self::assertIsString($failed);
        $this->relay('outgoing/claim');
        self::assertSame($failed, $this->decodedResponse()['id'] ?? null);
        $this->report($failed, ['sent' => false, 'error' => 'unconfirmed']);
        self::assertResponseStatusCodeSame(200);

        $this->client->jsonRequest('POST', '/api/v1/chat-outgoing/'.$failed.'/retry', [], $headers);
        self::assertResponseStatusCodeSame(403, 'A tool never sends an unconfirmed reply again.');
        $this->client->jsonRequest('POST', '/api/v1/chat-outgoing/'.$failed.'/retry', [], $this->personalAccessTokenHeaders('kim@example.test', ['chat:send']));
        self::assertResponseStatusCodeSame(403, 'Nor a script.');
        self::assertSame('failed', $this->connection()->fetchOne('SELECT status FROM chat_outgoing WHERE id = :id', ['id' => $failed]));

        // Once the claim's lease is over (before, the relay may still be sending it).
        $this->connection()->executeStatement("UPDATE chat_outgoing SET claimed_at = NOW() - INTERVAL '6 minutes' WHERE id = :id", ['id' => $failed]);
        $this->client->jsonRequest('POST', '/api/v1/chat-outgoing/'.$failed.'/retry', [], $this->web);
        self::assertResponseStatusCodeSame(200, 'The user does, in our app.');
        self::assertSame('waiting', $this->decodedResponse()['status'] ?? null);
    }

    public function testChatSendQueuesAReply(): void
    {
        $this->queueReply($this->chatId, 'From a tool', headers: $this->seededThirdPartyHeaders('kim@example.test', ['chat:send']));

        self::assertResponseStatusCodeSame(201);
    }

    public function testCallersWithoutAChatScopeNeverQueue(): void
    {
        $everyOther = array_map(static fn (Scope $scope): string => $scope->value, Scope::thirdPartyDefaultScopes());
        $this->queueReply($this->chatId, 'Hi', headers: $this->personalAccessTokenHeaders('kim@example.test', $everyOther));
        self::assertResponseStatusCodeSame(403);
        $this->queueReply($this->chatId, 'Hi', headers: $this->thirdPartyHeaders('kim@example.test', $everyOther));
        self::assertResponseStatusCodeSame(403);
        $this->queueReply($this->chatId, 'Hi', headers: $this->personalAccessTokenHeaders('kim@example.test', ['chat:read']));
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

    public function testACancelledRepeatIsRefusedAsCancelledAndCountsAgainstNoLimit(): void
    {
        // The test limit is 8 replies in 10 minutes: one cancelled, then the limit filled.
        $cancelled = self::newReplyId();
        $this->queueReply($this->chatId, 'Never mind', $cancelled);
        self::assertResponseStatusCodeSame(201);
        $this->client->request('DELETE', '/api/v1/chat-outgoing/'.$cancelled, server: $this->web);
        self::assertResponseStatusCodeSame(204);
        for ($i = 2; $i <= 8; ++$i) {
            $this->queueReply($this->chatId, 'Reply '.$i);
            self::assertResponseStatusCodeSame(201);
        }

        // Looked up before any limit: the answer is "cancelled", not "too many", and nothing is counted.
        for ($i = 0; $i < 3; ++$i) {
            $this->queueReply($this->chatId, 'Never mind', $cancelled);
            self::assertResponseStatusCodeSame(409);
            self::assertSame('cancelled', $this->decodedResponse()['code'] ?? null);
        }
        $this->queueReply($this->chatId, 'Reply 9');
        self::assertResponseStatusCodeSame(429);
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
