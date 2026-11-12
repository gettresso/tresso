<?php

declare(strict_types=1);

namespace App\Tests\Functional;

use App\Security\Scope;

/**
 * Tresso's own state of a chat: read and archived through a time, which only moves forward so two devices never undo
 * each other, back in the inbox, and left out. None of it reaches WhatsApp; all of it reaches Kim's devices.
 */
final class ChatStateTest extends DatabaseTestCase
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
        $this->relayMessages([self::waMessage('M1', 'Hello', '2026-11-12T09:00:00+00:00'), self::waMessage('M2', 'Are you there?', '2026-11-12T09:14:00+00:00')]);
        $this->chatId = $this->chatId();
    }

    public function testReadAndArchiveOnlyMoveForward(): void
    {
        $cursor = $this->delta(0)['cursor'];

        $chat = $this->patch(['readThrough' => '2026-11-12T09:14:00+00:00', 'archivedThrough' => '2026-11-12T10:14:00+01:00']);

        self::assertResponseIsSuccessful();
        self::assertInstant('2026-11-12T09:14:00+00:00', $chat['readThrough'] ?? null);
        self::assertInstant('2026-11-12T09:14:00+00:00', $chat['archivedThrough'] ?? null);
        self::assertSame([$chat], $this->delta($cursor)['chats'], 'The delta and the answer give one shape.');

        $cursor = $this->delta(0)['cursor'];
        $chat = $this->patch(['readThrough' => '2026-11-12T09:00:00+00:00', 'archivedThrough' => '2026-11-12T09:00:00+00:00']);
        self::assertResponseIsSuccessful();
        self::assertInstant('2026-11-12T09:14:00+00:00', $chat['readThrough'] ?? null, 'An older time from a device that lagged is ignored.');
        self::assertInstant('2026-11-12T09:14:00+00:00', $chat['archivedThrough'] ?? null);
        self::assertSame($cursor, $this->delta($cursor)['cursor'], 'And is no change for clients.');
    }

    public function testNullPutsTheChatBackInTheInbox(): void
    {
        $this->patch(['archivedThrough' => '2026-11-12T09:14:00+00:00', 'readThrough' => '2026-11-12T09:14:00+00:00']);

        $chat = $this->patch(['archivedThrough' => null]);

        self::assertResponseIsSuccessful();
        self::assertArrayHasKey('archivedThrough', $chat);
        self::assertNull($chat['archivedThrough']);
        self::assertInstant('2026-11-12T09:14:00+00:00', $chat['readThrough'] ?? null, 'A field left out stays.');

        $chat = $this->patch(['readThrough' => '2026-11-12T09:15:00+00:00']);
        self::assertNull($chat['archivedThrough'] ?? null, 'Left out is not null.');
    }

    public function testATimeFarAheadIsRefused(): void
    {
        $this->patch(['readThrough' => '2099-01-01T00:00:00+00:00']);
        self::assertResponseStatusCodeSame(422);
        self::assertSame(['readThrough'], $this->violationPaths());

        $this->patch(['archivedThrough' => '2099-01-01T00:00:00+00:00']);
        self::assertResponseStatusCodeSame(422);
        self::assertSame(['archivedThrough'], $this->violationPaths());
        self::assertNull($this->delta(0)['chats'][0]['readThrough'] ?? null);
    }

    public function testLeavingOutRemovesMessagesAndRepliesAndTakesNoMore(): void
    {
        $this->queueReply($this->chatId, 'Count me in!');
        self::assertResponseStatusCodeSame(201);
        $replyId = $this->responseString('id');
        $messageIds = array_column($this->delta(0)['chatMessages'], 'id');
        $cursor = $this->delta(0)['cursor'];

        $chat = $this->patch(['leftOut' => true]);

        self::assertResponseIsSuccessful();
        self::assertTrue($chat['leftOut'] ?? null);
        self::assertSame(['chat_account' => 1, 'chat' => 1, 'chat_message' => 0, 'chat_outgoing' => 0], $this->chatRowCounts(), 'The chat stays, so the relay knows to leave it out.');
        $page = $this->delta($cursor);
        $deleted = $page['deleted'];
        usort($deleted, static fn (array $a, array $b): int => [$a['type'], $a['id']] <=> [$b['type'], $b['id']]);
        $expected = [...array_map(static fn (mixed $id): array => ['type' => 'chatMessage', 'id' => $id], $messageIds), ['type' => 'chatOutgoing', 'id' => $replyId]];
        usort($expected, static fn (array $a, array $b): int => [$a['type'], $a['id']] <=> [$b['type'], $b['id']]);
        self::assertSame($expected, $deleted);
        self::assertSame([$chat], $page['chats']);

        $answer = $this->relayMessages([self::waMessage('M3', 'Hello again', '2026-11-12T10:00:00+00:00')]);
        self::assertSame(['left_out'], $answer['results'] ?? null);
        self::assertSame(0, $this->countRows('SELECT COUNT(*) FROM chat_message'));

        $chat = $this->patch(['leftOut' => false]);
        self::assertFalse($chat['leftOut'] ?? null);
        $answer = $this->relayMessages([self::waMessage('M4', 'And again', '2026-11-12T10:05:00+00:00')]);
        self::assertSame(['stored'], $answer['results'] ?? null, 'Taken in again from then on.');
    }

    public function testAnotherUsersChatIsNotFound(): void
    {
        $this->patch(['leftOut' => true], $this->userHeaders('lisa@example.test', ['mail:read', 'mail:write']));

        self::assertResponseStatusCodeSame(404);
        self::assertFalse($this->delta(0)['chats'][0]['leftOut'] ?? null);
    }

    public function testOnlyOurAppsWithMailWriteChangeIt(): void
    {
        $everything = array_map(static fn (Scope $scope): string => $scope->value, Scope::personalAccessTokenScopes());
        foreach ([
            'our web app without mail:write' => $this->userHeaders('kim@example.test', ['mail:read', 'mail:send']),
            'a token holding chat:read and chat:send' => $this->seededThirdPartyHeaders('kim@example.test', ['chat:read', 'chat:send', 'mail:write']),
            'a personal access token' => $this->personalAccessTokenHeaders('kim@example.test', $everything),
        ] as $caller => $headers) {
            $this->patch(['leftOut' => true, 'readThrough' => '2026-11-12T09:14:00+00:00'], $headers);
            self::assertResponseStatusCodeSame(403, $caller);
        }
        $this->client->request('PATCH', '/api/v1/chats/'.$this->chatId, server: ['HTTP_ACCEPT' => 'application/json', 'CONTENT_TYPE' => 'application/merge-patch+json'], content: '{"leftOut":true}');
        self::assertResponseStatusCodeSame(401);

        $chat = $this->delta(0)['chats'][0];
        self::assertFalse($chat['leftOut'] ?? null);
        self::assertNull($chat['readThrough'] ?? null);
        self::assertSame(2, $this->countRows('SELECT COUNT(*) FROM chat_message'));
    }

    public function testEveryOwnAppMayChangeIt(): void
    {
        foreach (['web', 'desktop', 'mobile'] as $client) {
            $this->patch(['readThrough' => '2026-11-12T09:14:00+00:00'], $this->userHeaders('kim@example.test', ['mail:write'], $client));
            self::assertResponseIsSuccessful($client);
        }
    }

    /**
     * @param array<string, mixed>       $change
     * @param array<string, string>|null $headers
     *
     * @return array<mixed>
     */
    private function patch(array $change, ?array $headers = null): array
    {
        $this->client->request('PATCH', '/api/v1/chats/'.$this->chatId, server: ($headers ?? $this->web) + ['CONTENT_TYPE' => 'application/merge-patch+json'], content: json_encode($change, \JSON_THROW_ON_ERROR));

        return $this->decodedResponse();
    }
}
