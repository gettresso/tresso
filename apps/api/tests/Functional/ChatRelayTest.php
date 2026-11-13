<?php

declare(strict_types=1);

namespace App\Tests\Functional;

use App\Security\Scope;
use PHPUnit\Framework\Attributes\DataProvider;

/**
 * The relay: Kim's desktop passes the messages of her WhatsApp bridge on to the server, and only that desktop. Every
 * batch is safe to send again, everything readable about whom she talks to is sealed, and every change reaches her
 * devices through the delta.
 */
final class ChatRelayTest extends DatabaseTestCase
{
    use AuthenticatesUsers;
    use ConnectsThirdPartyApps;
    use RelaysChats;
    use SeedsAccessTokens;
    use StoresChats;

    protected function setUp(): void
    {
        parent::setUp();
        $this->setUpRelay();
    }

    public function testStatusChangesTheAccountOnlyWhenAValueDiffers(): void
    {
        $status = ['bridge' => 'running', 'link' => 'linked', 'linkedAt' => '2026-11-12T13:48:14+01:00', 'loopbackOnly' => true];
        $cursor = $this->delta(0)['cursor'];

        $this->relay('status', $status);

        self::assertResponseStatusCodeSame(200);
        self::assertSame(['relay' => 'active'], $this->decodedResponse());
        $page = $this->delta($cursor);
        self::assertCount(1, $page['chatAccounts']);
        self::assertSame('linked', $page['chatAccounts'][0]['link'] ?? null);
        self::assertSame('running', $page['chatAccounts'][0]['bridge'] ?? null);
        self::assertInstant('2026-11-12T12:48:14+00:00', $page['chatAccounts'][0]['linkedAt'] ?? null, 'Stored as the instant it names.');
        self::assertTrue($page['chatAccounts'][0]['loopbackOnly'] ?? null);

        $cursor = $page['cursor'];
        $this->relay('status', $status);
        self::assertResponseStatusCodeSame(200);
        self::assertSame($cursor, $this->delta($cursor)['cursor'], 'The same report again is no change for clients.');

        $this->relay('status', ['link' => 'unlinked'] + $status);
        self::assertSame('unlinked', $this->delta($cursor)['chatAccounts'][0]['link'] ?? null);
    }

    public function testAStatusFromABridgeLinkedToAnotherNumberIsRefused(): void
    {
        $status = ['bridge' => 'running', 'link' => 'linked', 'linkedAt' => null, 'loopbackOnly' => true];

        $this->relay('status', $status + ['address' => '31698765432']);
        self::assertResponseStatusCodeSame(200);

        $this->relay('status', $status + ['address' => '31611112222']);
        self::assertResponseStatusCodeSame(409);
        self::assertSame('other_number', $this->decodedResponse()['code'] ?? null);

        // An account that did not know its number learns it from the first status that says it.
        $this->connection()->executeStatement('UPDATE chat_account SET sealed_address = NULL');
        $this->relay('status', $status + ['address' => '31611112222']);
        self::assertResponseStatusCodeSame(200);
        $this->relay('status', $status + ['address' => '31698765432']);
        self::assertResponseStatusCodeSame(409);
    }

    public function testMessagesAreStoredSealedAndReachTheDelta(): void
    {
        $cursor = $this->delta(0)['cursor'];

        $answer = $this->relayMessages([
            self::waMessage('3EB0C767D26A1B2C3D4E', 'Can you bring the drill on Saturday?'),
            self::waMessage('3EB0A1B2C3D4E5F60718', '', '2026-11-12T09:13:00+00:00', ['media' => ['kind' => 'image', 'name' => 'image_20261112_101300.jpg', 'size' => 184220]]),
        ]);

        self::assertSame(['stored' => 2, 'known' => 0, 'leftOut' => 0, 'refused' => 0, 'results' => ['stored', 'stored']], $answer);
        $page = $this->delta($cursor);
        self::assertCount(1, $page['chats']);
        $chat = $page['chats'][0];
        self::assertSame(self::JID, $chat['jid'] ?? null);
        self::assertSame('Bram Visser', $chat['name'] ?? null);
        self::assertSame('direct', $chat['kind'] ?? null);
        self::assertInstant('2026-11-12T09:14:00+00:00', $chat['lastMessageAt'] ?? null, 'The newest message.');
        self::assertNull($chat['readThrough'] ?? null, 'Not the first import: the messages are unread.');
        $messages = array_column($page['chatMessages'], null, 'waId');
        self::assertSame('Can you bring the drill on Saturday?', $messages['3EB0C767D26A1B2C3D4E']['text'] ?? null);
        self::assertSame('image', $messages['3EB0A1B2C3D4E5F60718']['mediaKind'] ?? null);
        self::assertSame('image_20261112_101300.jpg', $messages['3EB0A1B2C3D4E5F60718']['mediaName'] ?? null);
        self::assertSame(184220, $messages['3EB0A1B2C3D4E5F60718']['mediaSize'] ?? null);

        $raw = json_encode([
            $this->connection()->fetchAllAssociative('SELECT * FROM chat'),
            $this->connection()->fetchAllAssociative('SELECT * FROM chat_message'),
        ], \JSON_THROW_ON_ERROR);
        foreach (['31612345678', 'Bram', 'drill', '3EB0C767D26A1B2C3D4E', 'image_2026'] as $plaintext) {
            self::assertStringNotContainsString($plaintext, $raw, 'Nothing about whom Kim talks to is stored readable.');
        }
    }

    public function testTheSameBatchTwiceStoresNothingNew(): void
    {
        $batch = [self::waMessage('M1', 'Hello'), self::waMessage('M2', 'Are you there?', '2026-11-12T09:15:00+00:00')];
        $this->relayMessages($batch);
        $seq = $this->kimsChangeSeq();
        $rows = $this->chatRowCounts();

        $answer = $this->relayMessages($batch);

        self::assertSame(['stored' => 0, 'known' => 2, 'leftOut' => 0, 'refused' => 0, 'results' => ['known', 'known']], $answer);
        self::assertSame($rows, $this->chatRowCounts());
        self::assertSame($seq, $this->kimsChangeSeq(), 'A replayed batch is no change for clients.');
    }

    public function testAMessageTwiceInOneBatchIsStoredOnce(): void
    {
        $answer = $this->relayMessages([self::waMessage('M1', 'Hello'), self::waMessage('M1', 'Hello'), self::waMessage('M2', 'Bye')]);

        self::assertSame(['stored' => 2, 'known' => 1, 'leftOut' => 0, 'refused' => 0, 'results' => ['stored', 'known', 'stored']], $answer);
        self::assertSame(2, $this->countRows('SELECT COUNT(*) FROM chat_message'));
    }

    public function testAJidIsStoredInOneFormSoAChatNeverBecomesTwo(): void
    {
        $this->relayMessages([self::waMessage('M1', 'Hello')]);

        $answer = $this->relayMessages(
            [self::waMessage('M1', 'Hello', extra: ['chatJid' => '31612345678:12@S.WhatsApp.Net']), self::waMessage('M2', 'Hi', extra: ['chatJid' => '31612345678.0:3@s.whatsapp.net'])],
            [['jid' => '31612345678:12@S.WhatsApp.Net', 'name' => 'Bram Visser', 'kind' => 'direct']],
        );

        self::assertSame(['known', 'stored'], $answer['results']);
        self::assertSame(1, $this->countRows('SELECT COUNT(*) FROM chat'));
        self::assertSame([self::JID], array_column($this->delta(0)['chats'], 'jid'));
    }

    public function testAMessageMayNameAChatTheServerHasAlready(): void
    {
        $this->relayMessages([self::waMessage('M1', 'Hello')]);

        $answer = $this->relayMessages([self::waMessage('M2', 'Again')], []);

        self::assertSame(['stored'], $answer['results']);
    }

    public function testAMessageOfAChatNobodyNamedIsRefused(): void
    {
        $this->relay('messages', ['chats' => [], 'messages' => [self::waMessage('M1', 'A secret plan', extra: ['chatJid' => self::OTHER_JID])]]);

        self::assertResponseStatusCodeSame(422);
        self::assertSame(['messages[0].chatJid'], $this->violationPaths());
        $body = (string) $this->client->getResponse()->getContent();
        self::assertStringNotContainsString('31687654321', $body, 'Nothing the relay sends about a chat is echoed back.');
        self::assertStringNotContainsString('secret', $body);
        self::assertSame(['chat_account' => 1, 'chat' => 0, 'chat_message' => 0, 'chat_outgoing' => 0], $this->chatRowCounts());
    }

    public function testABatchIsStoredWholeOrNotAtAll(): void
    {
        $this->relay('messages', [
            'chats' => [['jid' => self::JID, 'name' => 'Bram', 'kind' => 'direct']],
            'messages' => [self::waMessage('M1', 'Hello'), self::waMessage('M2', 'Hi', extra: ['chatJid' => self::OTHER_JID])],
        ]);

        self::assertResponseStatusCodeSame(422);
        self::assertSame(['chat_account' => 1, 'chat' => 0, 'chat_message' => 0, 'chat_outgoing' => 0], $this->chatRowCounts());
    }

    public function testALeftOutChatAndAnExcludedGroupAreCountedNotStored(): void
    {
        $this->relayMessages([self::waMessage('M1', 'Hello')]);
        $chatId = $this->chatId();
        $this->client->request('PATCH', '/api/v1/chats/'.$chatId, server: $this->web + ['CONTENT_TYPE' => 'application/merge-patch+json'], content: '{"leftOut":true}');
        self::assertResponseIsSuccessful();
        $this->client->request('PATCH', '/api/v1/chat-accounts/'.$this->accountId, server: $this->web + ['CONTENT_TYPE' => 'application/merge-patch+json'], content: '{"includeGroups":false}');
        self::assertResponseIsSuccessful();

        $answer = $this->relayMessages(
            [self::waMessage('M2', 'Still there?'), self::waMessage('G1', 'Dinner on Sunday?', extra: ['chatJid' => self::GROUP_JID, 'sender' => ['id' => '31655555555', 'name' => 'Mia']])],
            [['jid' => self::JID, 'name' => 'Renamed', 'kind' => 'direct'], ['jid' => self::GROUP_JID, 'name' => 'Family', 'kind' => 'group']],
        );

        self::assertSame(['stored' => 0, 'known' => 0, 'leftOut' => 2, 'refused' => 0, 'results' => ['left_out', 'left_out']], $answer);
        self::assertSame(0, $this->countRows('SELECT COUNT(*) FROM chat_message'));
        self::assertSame([$chatId], $this->connection()->fetchFirstColumn('SELECT id FROM chat'), 'No chat is made for an excluded group.');
        self::assertSame('Bram Visser', $this->delta(0)['chats'][0]['name'] ?? null, 'Nothing of a left-out chat is taken, not its name either.');
    }

    public function testAChatLeftOutOnTheDesktopIsKeptAsALeftOutRowWithNothingButItsJid(): void
    {
        $leftOut = ['jid' => self::OTHER_JID, 'name' => 'Not to be kept', 'kind' => 'direct', 'leftOut' => true];

        $answer = $this->relayMessages([self::waMessage('M1', 'A secret plan', extra: ['chatJid' => self::OTHER_JID])], [$leftOut]);
        $this->relayMessages([], [$leftOut]);

        self::assertSame(['stored' => 0, 'known' => 0, 'leftOut' => 1, 'refused' => 0], array_intersect_key($answer, array_flip(['stored', 'known', 'leftOut', 'refused'])));
        self::assertSame(1, $this->countRows('SELECT COUNT(*) FROM chat'), 'Once, also when handed over again.');
        $row = $this->connection()->fetchAssociative('SELECT left_out, sealed_name, sealed_jid FROM chat');
        self::assertIsArray($row);
        self::assertTrue((bool) $row['left_out']);
        self::assertNull($row['sealed_name'], 'No name is kept.');
        self::assertStringNotContainsString(self::OTHER_JID, (string) $row['sealed_jid']);
        self::assertSame(0, $this->countRows('SELECT COUNT(*) FROM chat_message'));
        $chats = $this->delta(0)['chats'];
        self::assertCount(1, $chats);
        self::assertTrue($chats[0]['leftOut'] ?? null);
        self::assertSame(self::OTHER_JID, $chats[0]['jid'] ?? null);

        // Later batches leave its messages out too.
        $later = $this->relayMessages([self::waMessage('M2', 'Another', extra: ['chatJid' => self::OTHER_JID])], []);
        self::assertSame(1, $later['leftOut'] ?? null);
    }

    public function testALeftOutEntryLeavesAChatTheServerHoldsAsItIs(): void
    {
        $this->relayMessages([self::waMessage('M1', 'Hi')]);

        $this->relayMessages([], [['jid' => self::JID, 'name' => null, 'kind' => 'direct', 'leftOut' => true]]);

        self::assertFalse((bool) $this->connection()->fetchOne('SELECT left_out FROM chat'));
        self::assertSame(1, $this->countRows('SELECT COUNT(*) FROM chat_message'));
    }

    public function testTheFirstImportArrivesRead(): void
    {
        $this->relayMessages([self::waMessage('M1', 'Old news', '2026-10-20T08:00:00+00:00'), self::waMessage('M2', 'Older news', '2026-10-19T08:00:00+00:00')], firstImport: true);
        $this->relayMessages([self::waMessage('M0', 'Oldest news', '2026-10-21T08:00:00+00:00')], firstImport: true);

        $chat = $this->delta(0)['chats'][0];
        self::assertInstant('2026-10-21T08:00:00+00:00', $chat['readThrough'] ?? null, 'Every batch of the first import arrives read.');
        self::assertInstant('2026-10-21T08:00:00+00:00', $chat['lastMessageAt'] ?? null);

        $this->relayMessages([self::waMessage('M3', 'New', '2026-11-12T09:00:00+00:00')]);
        $chat = $this->delta(0)['chats'][0];
        self::assertInstant('2026-10-21T08:00:00+00:00', $chat['readThrough'] ?? null, 'After the first import new messages are unread.');
        self::assertInstant('2026-11-12T09:00:00+00:00', $chat['lastMessageAt'] ?? null);
    }

    public function testFirstImportAfterItEndedChangesNoReadTime(): void
    {
        $this->relayMessages([self::waMessage('M1', 'Hello', '2026-11-12T09:00:00+00:00')]);
        $this->relayMessages(
            [self::waMessage('M2', 'Unread', '2026-11-12T09:05:00+00:00'), self::waMessage('N1', 'Hi', '2026-11-12T09:06:00+00:00', ['chatJid' => self::OTHER_JID])],
            [['jid' => self::JID, 'name' => 'Bram', 'kind' => 'direct'], ['jid' => self::OTHER_JID, 'name' => 'Anna', 'kind' => 'direct']],
            firstImport: true,
        );

        foreach ($this->delta(0)['chats'] as $chat) {
            self::assertNull($chat['readThrough'] ?? null, 'The first import ended with the first batch without it.');
        }
    }

    public function testANewRelayStartsItsOwnFirstImportButLeavesUnreadChatsAlone(): void
    {
        $this->relayMessages([self::waMessage('M1', 'Unread', '2026-11-12T09:00:00+00:00')]);
        $this->connectWhatsApp($this->userHeaders('kim@example.test', ['mail:read', 'mail:write'], 'desktop'), self::OTHER_MAC);

        $this->relay('messages', [
            'deviceId' => self::OTHER_MAC,
            'firstImport' => true,
            'chats' => [['jid' => self::JID, 'name' => 'Bram', 'kind' => 'direct'], ['jid' => self::OTHER_JID, 'name' => 'Anna', 'kind' => 'direct']],
            'messages' => [self::waMessage('M2', 'Also unread', '2026-11-12T09:05:00+00:00'), self::waMessage('N1', 'History', '2026-11-12T08:00:00+00:00', ['chatJid' => self::OTHER_JID])],
        ]);
        self::assertResponseStatusCodeSame(200);

        $chats = array_column($this->delta(0)['chats'], null, 'jid');
        self::assertNull($chats[self::JID]['readThrough'] ?? null, 'A chat with unread messages stays unread.');
        self::assertInstant('2026-11-12T08:00:00+00:00', $chats[self::OTHER_JID]['readThrough'] ?? null, 'A chat of the new relay\'s import arrives read.');
    }

    public function testTheLastMessageTimeOnlyMovesForwardAndNamesFollowTheBridge(): void
    {
        $this->relayMessages([self::waMessage('M1', 'New', '2026-11-12T09:00:00+00:00')]);

        $this->relayMessages(
            [self::waMessage('M0', 'Old', '2026-11-01T09:00:00+00:00')],
            [['jid' => self::JID, 'name' => "Bram\u{202E}  van\nDijk\u{0007}".str_repeat('x', 300), 'kind' => 'direct']],
        );

        $chat = $this->delta(0)['chats'][0];
        self::assertInstant('2026-11-12T09:00:00+00:00', $chat['lastMessageAt'] ?? null);
        self::assertIsString($chat['name'] ?? null);
        self::assertStringStartsWith('Bram van Dijk', $chat['name'], 'Control characters and direction overrides removed, whitespace one space.');
        self::assertSame(255, mb_strlen($chat['name']), 'Cut, not refused.');
    }

    public function testATextOfTheDesktopsLimitIsStored(): void
    {
        $text = str_repeat('é', 65_536);

        $this->relayMessages([self::waMessage('M1', $text)]);

        self::assertSame($text, $this->delta(0)['chatMessages'][0]['text'] ?? null);
    }

    /**
     * @return iterable<string, array{array<string, mixed>, string}>
     */
    public static function invalidBatches(): iterable
    {
        $chat = ['jid' => self::JID, 'name' => 'Bram', 'kind' => 'direct'];
        $message = self::waMessage('M1', 'Hello');

        yield 'more than 200 messages' => [['chats' => [$chat], 'messages' => array_map(static fn (int $i): array => self::waMessage('M'.$i, 'Hi'), range(1, 201))], 'messages'];
        yield 'more than 200 chats' => [['chats' => array_map(static fn (int $i): array => ['jid' => (31600000000 + $i).'@s.whatsapp.net', 'name' => null, 'kind' => 'direct'], range(1, 201)), 'messages' => []], 'chats'];
        yield 'a text longer than the desktop cuts at' => [['chats' => [$chat], 'messages' => [self::waMessage('M1', str_repeat('a', 65_537))]], 'messages[0].text'];
        yield 'a name longer than the desktop cuts at' => [['chats' => [['name' => str_repeat('a', 65_537)] + $chat], 'messages' => []], 'chats[0].name'];
        yield 'a kind that does not match the chat' => [['chats' => [['kind' => 'group'] + $chat], 'messages' => []], 'chats[0].kind'];
        yield 'one chat twice' => [['chats' => [$chat, ['jid' => '31612345678:3@s.whatsapp.net'] + $chat], 'messages' => []], 'chats[1].jid'];
        yield 'no time' => [['chats' => [$chat], 'messages' => [['sentAt' => null] + $message]], 'messages[0].sentAt'];
        yield 'a file of negative size' => [['chats' => [$chat], 'messages' => [['media' => ['kind' => 'image', 'name' => null, 'size' => -1]] + $message]], 'messages[0].media.size'];
        yield 'a WhatsApp id longer than any id' => [['chats' => [$chat], 'messages' => [['waId' => str_repeat('A', 1025)] + $message]], 'messages[0].waId'];
        yield 'a device id that is no UUID' => [['deviceId' => 'my-mac', 'chats' => [$chat], 'messages' => [$message]], 'deviceId'];
    }

    /**
     * @param array<string, mixed> $body
     */
    #[DataProvider('invalidBatches')]
    public function testRefusesAnInvalidBatch(array $body, string $path): void
    {
        $this->relay('messages', $body);

        self::assertResponseStatusCodeSame(422);
        self::assertContains($path, $this->violationPaths());
        self::assertSame(0, $this->countRows('SELECT COUNT(*) FROM chat_message'));
        self::assertSame(0, $this->countRows('SELECT COUNT(*) FROM chat'));
    }

    /**
     * What the relay copies from the bridge's store and cannot repair.
     *
     * @return iterable<string, array{array<string, mixed>}>
     */
    public static function rowsTheRelayCannotRepair(): iterable
    {
        foreach (['0@s.whatsapp.net', 'status@broadcast', '120363144038483540@newsletter', '31612345678@c.us', 'abc@s.whatsapp.net', '31612345678', ''] as $jid) {
            yield 'the JID '.var_export($jid, true) => [['chatJid' => $jid]];
        }
        yield 'no WhatsApp id' => [['waId' => '']];
        yield 'a WhatsApp id with a space' => [['waId' => '3EB0 C767']];
        yield 'a WhatsApp id of 129 characters' => [['waId' => str_repeat('A', 129)]];
        yield 'a sender with a space in its id' => [['sender' => ['id' => '316 1234', 'name' => null]]];
        yield 'a time far in the future' => [['sentAt' => '2099-01-01T00:00:00+00:00']];
        yield 'a time before WhatsApp' => [['sentAt' => '1970-01-01T00:00:00+00:00']];
    }

    /**
     * @param array<string, mixed> $bad
     */
    #[DataProvider('rowsTheRelayCannotRepair')]
    public function testARowTheRelayCannotRepairIsRefusedAlone(array $bad): void
    {
        $answer = $this->relayMessages([
            self::waMessage('M1', 'Before'),
            self::waMessage('M2', 'A secret plan', extra: $bad),
            self::waMessage('M3', 'After', '2026-11-12T09:15:00+00:00'),
        ]);

        self::assertSame(['stored' => 2, 'known' => 0, 'leftOut' => 0, 'refused' => 1, 'results' => ['stored', 'refused', 'stored']], $answer);
        self::assertSame(['Before', 'After'], array_column($this->delta(0)['chatMessages'], 'text'));
        self::assertStringNotContainsString('secret', (string) $this->client->getResponse()->getContent());
    }

    public function testAChatThatIsNoChatIsLeftAside(): void
    {
        $answer = $this->relayMessages(
            [self::waMessage('S1', 'A status', extra: ['chatJid' => 'status@broadcast']), self::waMessage('M1', 'Hello')],
            [['jid' => 'status@broadcast', 'name' => 'Status', 'kind' => 'direct'], ['jid' => self::JID, 'name' => 'Bram', 'kind' => 'direct']],
        );

        self::assertSame(['refused', 'stored'], $answer['results'] ?? null);
        self::assertSame(1, $this->countRows('SELECT COUNT(*) FROM chat'));
    }

    public function testABatchLargerThanEightMegabytesIs413WithoutALength(): void
    {
        $messages = array_map(static fn (int $i): array => self::waMessage('M'.$i, str_repeat('a', 65_536)), range(1, 130));

        $this->relay('messages', ['chats' => [['jid' => self::JID, 'name' => 'Bram', 'kind' => 'direct']], 'messages' => $messages]);

        self::assertResponseStatusCodeSame(413);
        self::assertSame('too_large', $this->decodedResponse()['code'] ?? null);
        self::assertSame(0, $this->countRows('SELECT COUNT(*) FROM chat_message'));
    }

    public function testABatchAnnouncedLargerThanEightMegabytesIs413BeforeItIsRead(): void
    {
        $this->client->request('POST', '/api/v1/chat-accounts/'.$this->accountId.'/relay/messages', server: $this->desktop + ['CONTENT_TYPE' => 'application/json', 'CONTENT_LENGTH' => (string) (8 * 1024 * 1024 + 1)], content: '{"deviceId":"'.self::MAC.'","chats":[],"messages":[]}');

        self::assertResponseStatusCodeSame(413);
        self::assertSame('too_large', $this->decodedResponse()['code'] ?? null);
    }

    public function testALargeBatchGetsAChangeNumberPerMegabyteSoADeltaPageStaysSmall(): void
    {
        $cursor = $this->delta(0)['cursor'];
        $messages = array_map(static fn (int $i): array => self::waMessage('M'.$i, str_repeat(\chr(64 + $i % 26), 60_000), \sprintf('2026-11-12T09:%02d:00+00:00', $i)), range(1, 40));

        $this->relayMessages($messages);

        self::assertGreaterThanOrEqual(3, $this->countRows('SELECT COUNT(DISTINCT change_seq) FROM chat_message'), 'About a megabyte of text per change number.');
        $this->client->request('GET', \sprintf('/api/v1/sync/changes?since=%d&limit=200', $cursor), server: $this->web);
        self::assertResponseIsSuccessful();
        $page = $this->decodedResponse();
        self::assertTrue($page['hasMore'] ?? null, 'Long messages fill a page sooner than short ones.');
        self::assertIsArray($page['chatMessages'] ?? null);
        self::assertLessThan(40, \count($page['chatMessages']));
    }

    public function testImportsAreLimitedPerAccount(): void
    {
        // The test limit is 30 batches.
        for ($i = 1; $i <= 30; ++$i) {
            $this->relayMessages([self::waMessage('M'.$i, 'Hi')]);
        }

        $this->relay('messages', ['chats' => [], 'messages' => [self::waMessage('M31', 'Hi')]]);

        self::assertResponseStatusCodeSame(429);
        self::assertTrue($this->client->getResponse()->headers->has('Retry-After'));
        self::assertGreaterThan(0, (int) $this->client->getResponse()->headers->get('Retry-After'), 'The relay knows when to send the next one.');
        self::assertSame(30, $this->countRows('SELECT COUNT(*) FROM chat_message'));
    }

    public function testAnotherDesktopIsNotTheRelay(): void
    {
        $this->relayMessages([self::waMessage('M1', 'Hello')]);
        $this->client->jsonRequest('POST', '/api/v1/chats/'.$this->chatId().'/outgoing', ['id' => self::newReplyId(), 'text' => 'Hi'], $this->web);
        self::assertResponseStatusCodeSame(201);
        $replyId = $this->responseString('id');
        $rows = $this->chatRowCounts();
        $seq = $this->kimsChangeSeq();

        foreach (['status' => ['bridge' => 'stopped', 'link' => 'unlinked'], 'messages' => ['chats' => [], 'messages' => [self::waMessage('M2', 'Bye')]], 'outgoing/claim' => [], 'outgoing/'.$replyId.'/result' => ['sent' => true, 'claimToken' => 'no-claim']] as $path => $body) {
            $this->relay($path, ['deviceId' => self::OTHER_MAC] + $body);
            self::assertResponseStatusCodeSame(409, $path);
            self::assertSame('not_the_relay', $this->decodedResponse()['code'] ?? null, $path);
        }
        self::assertSame($rows, $this->chatRowCounts());
        self::assertSame($seq, $this->kimsChangeSeq(), 'Nothing changed, not even when the relay was last heard from.');
        self::assertSame('waiting', $this->delta(0)['chatOutgoing'][0]['status'] ?? null, 'The other desktop claimed nothing.');
    }

    public function testAfterATakeoverTheOldMacIsNotTheRelay(): void
    {
        $this->connectWhatsApp($this->userHeaders('kim@example.test', ['mail:read', 'mail:write'], 'desktop'), self::OTHER_MAC);

        $this->relay('status', ['bridge' => 'running', 'link' => 'linked']);
        self::assertResponseStatusCodeSame(409);
        self::assertSame('not_the_relay', $this->decodedResponse()['code'] ?? null);

        $this->relay('status', ['deviceId' => self::OTHER_MAC, 'bridge' => 'running', 'link' => 'linked']);
        self::assertResponseStatusCodeSame(200);
    }

    /**
     * @return iterable<string, array{string, list<string>}>
     */
    public static function ourOtherCallers(): iterable
    {
        yield 'the web app' => ['web', ['mail:read', 'mail:write', 'mail:send']];
        yield 'the mobile app' => ['mobile', ['mail:read', 'mail:write', 'mail:send']];
        yield 'the desktop app without mail:write' => ['desktop', ['mail:read', 'mail:send']];
    }

    /**
     * @param list<string> $scopes
     */
    #[DataProvider('ourOtherCallers')]
    public function testOnlyOurDesktopWithMailWriteRelays(string $client, array $scopes): void
    {
        $this->assertNoRelayCallWorks($this->userHeaders('kim@example.test', $scopes, $client), 403);
    }

    public function testAPersonalAccessTokenNeverRelays(): void
    {
        $this->assertNoRelayCallWorks($this->personalAccessTokenHeaders('kim@example.test', array_map(static fn (Scope $scope): string => $scope->value, Scope::personalAccessTokenScopes())), 403);
    }

    public function testAnAppThatIsNotOursNeverRelays(): void
    {
        $this->assertNoRelayCallWorks($this->thirdPartyHeaders('kim@example.test', array_map(static fn (Scope $scope): string => $scope->value, Scope::thirdPartyAppScopes())), 403);
        $this->assertNoRelayCallWorks($this->seededThirdPartyHeaders('kim@example.test', ['chat:read', 'chat:send', 'mail:read', 'mail:write']), 403);
    }

    public function testNeedsASignedInCaller(): void
    {
        $this->assertNoRelayCallWorks(['HTTP_ACCEPT' => 'application/json'], 401);
    }

    public function testAnotherUsersAccountIsNotFound(): void
    {
        $lisa = $this->userHeaders('lisa@example.test', ['mail:read', 'mail:write'], 'desktop');

        $this->assertNoRelayCallWorks($lisa, 404);

        // Lisa's own relay is hers alone.
        $lisasAccount = $this->connectWhatsApp($lisa, self::OTHER_MAC);
        $this->relay('status', ['bridge' => 'running', 'link' => 'linked'], accountId: $lisasAccount);
        self::assertResponseStatusCodeSame(404, 'Kim\'s Mac does not reach Lisa\'s account, whatever device id it names.');
    }

    public function testTheSweepPutsASilentRelayOfflineAndACallBringsItBack(): void
    {
        $this->connection()->executeStatement("UPDATE chat_account SET relay_seen_at = relay_seen_at - INTERVAL '4 minutes'");
        $seenAt = $this->connection()->fetchOne('SELECT relay_seen_at FROM chat_account');
        $cursor = $this->delta(0)['cursor'];

        self::assertSame(['offline' => 1, 'unconfirmed' => 0], $this->sweep());

        $account = $this->delta($cursor)['chatAccounts'][0] ?? null;
        self::assertIsArray($account, 'Going offline is a change for clients.');
        self::assertFalse($account['relayOnline'] ?? null);
        self::assertIsString($seenAt);
        self::assertInstant(new \DateTimeImmutable($seenAt)->format(\DATE_ATOM), $account['relayOfflineSince'] ?? null, 'Offline from when it was last heard from.');
        self::assertSame(['offline' => 0, 'unconfirmed' => 0], $this->sweep(), 'Once.');

        $cursor = $this->delta(0)['cursor'];
        $this->relay('status', ['bridge' => 'running', 'link' => 'linked']);
        self::assertResponseStatusCodeSame(200);
        $account = $this->delta($cursor)['chatAccounts'][0] ?? null;
        self::assertIsArray($account);
        self::assertTrue($account['relayOnline'] ?? null);
        self::assertArrayHasKey('relayOfflineSince', $account);
        self::assertNull($account['relayOfflineSince']);
    }

    public function testTheSweepLeavesARelayThatWasHeardFrom(): void
    {
        $this->connection()->executeStatement("UPDATE chat_account SET relay_seen_at = relay_seen_at - INTERVAL '2 minutes'");

        self::assertSame(['offline' => 0, 'unconfirmed' => 0], $this->sweep());
        self::assertTrue($this->delta(0)['chatAccounts'][0]['relayOnline'] ?? null);
    }

    /**
     * Every relay call, for Kim's account.
     *
     * @param array<string, string> $headers
     */
    private function assertNoRelayCallWorks(array $headers, int $status): void
    {
        $this->relayMessages([self::waMessage('M1', 'Hello')]);
        $this->client->jsonRequest('POST', '/api/v1/chats/'.$this->chatId().'/outgoing', ['id' => self::newReplyId(), 'text' => 'Hi'], $this->web);
        self::assertResponseStatusCodeSame(201);
        $replyId = $this->responseString('id');
        $rows = $this->chatRowCounts();

        foreach (['status' => ['bridge' => 'stopped', 'link' => 'unlinked'], 'messages' => ['chats' => [], 'messages' => [self::waMessage('M2', 'Bye')]], 'outgoing/claim' => [], 'outgoing/'.$replyId.'/result' => ['sent' => true, 'claimToken' => 'no-claim']] as $path => $body) {
            $this->relay($path, $body, $headers);
            self::assertResponseStatusCodeSame($status, $path);
        }
        self::assertSame($rows, $this->chatRowCounts());
        $page = $this->delta(0);
        self::assertSame('waiting', $page['chatOutgoing'][0]['status'] ?? null);
        self::assertSame('running', $page['chatAccounts'][0]['bridge'] ?? null);
    }
}
