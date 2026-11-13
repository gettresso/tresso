<?php

declare(strict_types=1);

namespace App\Tests\Functional;

use App\Chat\ChatReader;
use App\Entity\Chat;
use App\Entity\ChatAccount;
use App\Enum\ChatKind;
use App\Security\Scope;
use Doctrine\ORM\EntityManagerInterface;
use Symfony\Component\Uid\Uuid;

/**
 * The WhatsApp read endpoints for callers that keep no copy through the delta: the status, the chats, one chat's
 * messages and replies, and the search. Each needs `chat:read` for a caller that is not one of our own apps (the
 * status also `chat:send`), reads only the signed-in user's chats and leaves out chats the user left out.
 */
final class ChatReadApiTest extends DatabaseTestCase
{
    use AuthenticatesUsers;
    use ConnectsThirdPartyApps;
    use HoldsWhatsAppChats;
    use SeedsAccessTokens;
    use StoresChats;

    /** @var array<string, string> */
    private array $reader;

    protected function setUp(): void
    {
        parent::setUp();
        $this->setUpWhatsApp();
        $this->reader = $this->seededThirdPartyHeaders('kim@example.test', ['chat:read']);
    }

    public function testTheStatusSaysWhetherWhatsAppIsOnTheServerWithoutNamesOrNumbers(): void
    {
        // The Mac's name is the user's: a caller that may only queue replies does not get it.
        foreach (['chat:read' => [$this->reader, 'Kim\'s MacBook Pro'], 'chat:send' => [$this->seededThirdPartyHeaders('kim@example.test', ['chat:send']), null]] as $scope => [$headers, $device]) {
            $status = $this->get('/chat-accounts/whatsapp/status', $headers);

            self::assertSame([
                'channel' => 'whatsapp',
                'onServer' => true,
                'chatAccountId' => $this->kimsAccount->getId()->toRfc4122(),
                'relayDeviceName' => $device,
                'relayOnline' => true,
                'relayOfflineSince' => null,
                'bridge' => 'running',
                'link' => 'unknown',
            ], $status, $scope);
            self::assertStringNotContainsString('31698765432', (string) $this->client->getResponse()->getContent(), 'The own number stays out.');
            self::assertStringNotContainsString('Kim Visser', (string) $this->client->getResponse()->getContent(), 'The own name stays out.');
            if (null === $device) {
                self::assertStringNotContainsString('MacBook', (string) $this->client->getResponse()->getContent());
            }
        }

        $this->relayGoesOffline();
        $status = $this->get('/chat-accounts/whatsapp/status', $this->reader);
        self::assertFalse($status['relayOnline'] ?? null);
        self::assertSame($this->at(60)->format(\DATE_ATOM), $status['relayOfflineSince'] ?? null);

        $noor = $this->get('/chat-accounts/whatsapp/status', $this->seededThirdPartyHeaders('noor@example.test', ['chat:read']));
        self::assertSame(['channel' => 'whatsapp', 'onServer' => false, 'chatAccountId' => null, 'relayDeviceName' => null, 'relayOnline' => null, 'relayOfflineSince' => null, 'bridge' => null, 'link' => null], $noor, 'Only this Mac, or not connected: the server holds nothing.');
    }

    public function testEveryReadNeedsAChatScope(): void
    {
        $everyOther = array_map(static fn (Scope $scope): string => $scope->value, Scope::thirdPartyDefaultScopes());
        $send = $this->seededThirdPartyHeaders('kim@example.test', ['chat:send']);
        foreach ([
            'a token with every other scope' => $this->personalAccessTokenHeaders('kim@example.test', $everyOther),
            'an app with every other scope' => $this->thirdPartyHeaders('kim@example.test', $everyOther),
        ] as $caller => $headers) {
            foreach (['/chat-accounts/whatsapp/status', '/chats', '/chats/'.$this->annaChat.'/messages'] as $path) {
                $this->client->request('GET', '/api/v1'.$path, server: $headers);
                self::assertResponseStatusCodeSame(403, $caller.': '.$path);
            }
            $this->client->jsonRequest('POST', '/api/v1/chat-messages/search', ['q' => 'friday'], $headers);
            self::assertResponseStatusCodeSame(403, $caller.': search');
        }
        foreach (['/chats', '/chats/'.$this->annaChat.'/messages'] as $path) {
            $this->client->request('GET', '/api/v1'.$path, server: $send);
            self::assertResponseStatusCodeSame(403, 'chat:send reads nothing: '.$path);
            self::assertStringNotContainsString('Anna', (string) $this->client->getResponse()->getContent());
        }
        $this->client->jsonRequest('POST', '/api/v1/chat-messages/search', ['q' => 'friday'], $send);
        self::assertResponseStatusCodeSame(403, 'chat:send searches nothing.');
        self::assertStringNotContainsString('Anna', (string) $this->client->getResponse()->getContent());
        $this->client->request('GET', '/api/v1/chats', server: ['HTTP_ACCEPT' => 'application/json']);
        self::assertResponseStatusCodeSame(401);

        $ours = $this->userHeaders('kim@example.test', ['mail:read']);
        self::assertCount(2, self::list($this->get('/chats', $ours)['items'] ?? null), 'Our own apps read with mail:read, as the voter says.');
    }

    public function testChatsAreListedNewestFirstAPageAtATimeWithoutThoseLeftOut(): void
    {
        $first = $this->get('/chats?limit=1', $this->reader);
        $items = self::list($first['items'] ?? null);
        self::assertSame([$this->annaChat], array_column($items, 'id'));
        self::assertSame([
            'id' => $this->annaChat,
            'chatAccountId' => $this->kimsAccount->getId()->toRfc4122(),
            'jid' => self::ANNA_JID,
            'name' => 'Anna de Vries',
            'kind' => 'direct',
            'lastMessageAt' => $this->at(50)->format(\DATE_ATOM),
            'readThrough' => null,
            'archivedThrough' => null,
            'leftOut' => false,
        ], $items[0], 'A chat as the delta has it.');
        $cursor = $first['nextCursor'] ?? null;
        self::assertIsString($cursor);

        $second = $this->get('/chats?limit=1&cursor='.$cursor, $this->reader);
        self::assertSame([$this->groupChat], array_column(self::list($second['items'] ?? null), 'id'));
        self::assertArrayHasKey('nextCursor', $second);

        self::assertNull($second['nextCursor'], 'The chat left out is not listed, so this is the last page.');

        $all = $this->get('/chats', $this->reader);
        self::assertSame([$this->annaChat, $this->groupChat], array_column(self::list($all['items'] ?? null), 'id'), 'Not Lisa\'s chat, not the one left out.');
        self::assertArrayHasKey('nextCursor', $all);

        self::assertNull($all['nextCursor']);
    }

    public function testChatsOfTheSameTimeKeepAStableOrder(): void
    {
        $account = $this->chatEntityManager()->find(ChatAccount::class, $this->kimsAccount->getId());
        self::assertInstanceOf(ChatAccount::class, $account);
        foreach (['31600000011', '31600000012', '31600000013'] as $number) {
            $this->chatAt($account, $number.'@s.whatsapp.net', 'Same time '.$number, ChatKind::Direct, 50);
        }
        $seen = [];
        $cursor = null;
        do {
            $page = $this->get('/chats?limit=2'.(null === $cursor ? '' : '&cursor='.$cursor), $this->reader);
            foreach (self::list($page['items'] ?? null) as $chat) {
                $seen[] = self::asText($chat['id'] ?? null);
            }
            $cursor = $page['nextCursor'] ?? null;
        } while (\is_string($cursor));

        self::assertCount(5, $seen);
        self::assertSame($seen, array_values(array_unique($seen)), 'No chat twice, none skipped.');
        self::assertSame(array_column(self::list($this->get('/chats', $this->reader)['items'] ?? null), 'id'), $seen);
    }

    /**
     * A cursor is not signed and not bound to a user or a chat: it only names a position (a time, a kind and a row id)
     * and every read filters by the signed-in user, so a cursor of another user's only moves within the caller's own
     * chats. What is checked is that it is one of the shape this API gives.
     */
    public function testParametersOutOfRangeAndCursorsOfAnotherShapeAreRefused(): void
    {
        foreach (['/chats?limit=0' => 'limit', '/chats?limit=101' => 'limit', '/chats?limit=ten' => 'limit', '/chats/'.$this->annaChat.'/messages?limit=500' => 'limit'] as $path => $field) {
            $this->client->request('GET', '/api/v1'.$path, server: $this->reader);
            self::assertResponseStatusCodeSame(422, $path);
            self::assertSame([$field], array_column(self::list($this->decodedResponse()['violations'] ?? null), 'propertyPath'), $path);
        }
        foreach ([
            'one letter' => [['q' => 'a'], 'q'],
            'too far back' => [['q' => 'friday', 'days' => 91], 'days'],
            'too many results' => [['q' => 'friday', 'limit' => 51], 'limit'],
            'too long' => [['q' => str_repeat('x', 201)], 'q'],
            'a control character' => [['q' => "fri\u{0001}day"], 'q'],
            'a chat id that is none' => [['q' => 'friday', 'chatId' => 'anna'], 'chatId'],
        ] as $case => [$body, $field]) {
            $this->client->jsonRequest('POST', '/api/v1/chat-messages/search', $body, $this->reader);
            self::assertResponseStatusCodeSame(422, $case);
            self::assertSame([$field], array_column(self::list($this->decodedResponse()['violations'] ?? null), 'propertyPath'), $case);
            self::assertStringNotContainsString('fri', (string) $this->client->getResponse()->getContent(), 'The text searched for is not repeated.');
        }
        foreach (['/chats?cursor=nonsense', '/chats/'.$this->annaChat.'/messages?cursor='.base64_encode('["x",0,"y"]')] as $path) {
            $this->client->request('GET', '/api/v1'.$path, server: $this->reader);
            self::assertResponseStatusCodeSame(400, $path);
        }
        $this->client->jsonRequest('POST', '/api/v1/chat-messages/search', ['q' => 'friday', 'cursor' => 'AAAA'], $this->reader);
        self::assertResponseStatusCodeSame(400);
        $this->client->jsonRequest('POST', '/api/v1/chat-messages/search', ['q' => 'friday', 'days' => 'ten'], $this->reader);
        self::assertResponseStatusCodeSame(400, 'A body of another shape.');
    }

    public function testTheSearchTextNeverGoesInAUrl(): void
    {
        $this->client->request('GET', '/api/v1/chat-messages/search?q=friday', server: $this->reader);

        self::assertContains($this->client->getResponse()->getStatusCode(), [404, 405], 'Only a POST with a JSON body searches.');
    }

    public function testAChatIsReadWithItsMessagesAndRepliesNewestFirst(): void
    {
        $page = $this->get('/chats/'.$this->annaChat.'/messages?limit=100', $this->reader);

        self::assertSame('Anna de Vries', self::asMap($page['chat'] ?? null)['name'] ?? null);
        $items = self::list($page['items'] ?? null);
        self::assertSame(
            [['reply', $this->ids['waiting']], ['message', $this->ids['see-you']], ['reply', $this->ids['slides']], ['message', $this->ids['agenda']], ['message', $this->ids['yes']], ['message', $this->ids['friday']]],
            array_map(static fn (array $item): array => [$item['type'] ?? null, $item['id'] ?? null], $items),
            'The reply the bridge also stored as an own message is left out, as the apps show it.',
        );
        self::assertArrayHasKey('nextCursor', $page);

        self::assertNull($page['nextCursor']);

        self::assertSame('waiting', $items[0]['status'] ?? null);
        self::assertSame('On my way', $items[0]['text'] ?? null);
        self::assertSame('sent', $items[2]['status'] ?? null);
        self::assertSame($this->at(25)->format(\DATE_ATOM), $items[2]['sentAt'] ?? null);
        self::assertSame(['document', 'Agenda.pdf', 48213], [$items[3]['mediaKind'] ?? null, $items[3]['mediaName'] ?? null, $items[3]['mediaSize'] ?? null]);
        self::assertSame(['id' => self::ANNA_JID, 'name' => 'Anna de Vries'], $items[5]['sender'] ?? null);
        self::assertSame('Are we still on for Friday?', $items[5]['text'] ?? null);
        self::assertTrue($items[4]['fromMe'] ?? null);
    }

    public function testPagesOfAChatFollowOnWithoutGapsOrRepeats(): void
    {
        $whole = array_column(self::list($this->get('/chats/'.$this->annaChat.'/messages?limit=100', $this->reader)['items'] ?? null), 'id');
        foreach ([1, 2, 3] as $limit) {
            $seen = [];
            $cursor = null;
            $pages = 0;
            do {
                $page = $this->get('/chats/'.$this->annaChat.'/messages?limit='.$limit.(null === $cursor ? '' : '&cursor='.$cursor), $this->reader);
                $items = self::list($page['items'] ?? null);
                self::assertLessThanOrEqual($limit, \count($items));
                foreach ($items as $item) {
                    $seen[] = $item['id'];
                }
                $cursor = $page['nextCursor'] ?? null;
                self::assertLessThan(20, ++$pages, 'The pages end.');
            } while (\is_string($cursor));

            self::assertSame($whole, $seen, 'limit '.$limit);
        }
    }

    public function testAnotherUsersChatAndAChatLeftOutAreNotFound(): void
    {
        foreach ([$this->lisasChat, $this->leftOutChat, '0193a1c2-7b1e-7c3a-9f00-1b2c3d4e5f60'] as $chat) {
            $this->client->request('GET', '/api/v1/chats/'.$chat.'/messages', server: $this->reader);
            self::assertResponseStatusCodeSame(404, $chat);
            self::assertStringNotContainsString('secret', (string) $this->client->getResponse()->getContent());

            $this->client->jsonRequest('POST', '/api/v1/chat-messages/search', ['q' => 'friday', 'chatId' => $chat], $this->reader);
            self::assertResponseStatusCodeSame(404, $chat);
        }
    }

    public function testSearchLooksInTextFileNamesAndSendersIgnoringCase(): void
    {
        $friday = $this->search(['q' => 'FRIDAY'], $this->reader);
        self::assertSame([$this->ids['friday']], array_column(self::list($friday['items'] ?? null), 'id'), 'Not the chat left out, not Lisa\'s.');
        $hit = self::list($friday['items'] ?? null)[0];
        self::assertSame(['Anna de Vries', 'direct', $this->annaChat, 'Are we still on for Friday?'], [$hit['chatName'] ?? null, $hit['chatKind'] ?? null, $hit['chatId'] ?? null, $hit['text'] ?? null]);
        self::assertTrue($friday['complete'] ?? null);
        self::assertArrayHasKey('nextCursor', $friday);

        self::assertNull($friday['nextCursor']);
        self::assertSame(5, $friday['scanned'] ?? null, 'Kim\'s messages in the chats she keeps.');
        self::assertSame(ChatReader::SEARCH_SCAN, $friday['scanLimit'] ?? null);
        self::assertSame($this->at(0)->format(\DATE_ATOM), $friday['searchedThrough'] ?? null);

        self::assertSame([$this->ids['agenda']], array_column(self::list($this->search(['q' => 'agenda.PDF'], $this->reader)['items'] ?? null), 'id'));
        self::assertSame([$this->ids['morning']], array_column(self::list($this->search(['q' => 'bram'], $this->reader)['items'] ?? null), 'id'));
        self::assertSame([], self::list($this->search(['q' => 'bram', 'chatId' => $this->annaChat], $this->reader)['items'] ?? null));
        self::assertSame([$this->ids['see-you'], $this->ids['agenda'], $this->ids['friday']], array_column(self::list($this->search(['q' => 'anna', 'chatId' => $this->annaChat], $this->reader)['items'] ?? null), 'id'), 'Newest first, by sender name.');
    }

    public function testSearchKeepsToItsWindow(): void
    {
        $chat = $this->chatEntityManager()->find(Chat::class, Uuid::fromString($this->annaChat));
        self::assertInstanceOf(Chat::class, $chat);
        $this->messageAt($chat, 'ancient', 0, 'An ancient plan', sentAt: new \DateTimeImmutable('-40 days'));

        $recent = $this->search(['q' => 'ancient'], $this->reader);
        self::assertSame([], self::list($recent['items'] ?? null));
        self::assertTrue($recent['complete'] ?? null);

        self::assertSame([$this->ids['ancient']], array_column(self::list($this->search(['q' => 'ancient', 'days' => 45], $this->reader)['items'] ?? null), 'id'));
    }

    /**
     * Chat text is sealed, so a search opens each message it compares: at most SEARCH_SCAN a call, newest first. A
     * match further back is found by the next call, from the cursor.
     */
    public function testSearchOpensAtMostItsLimitACallAndGoesOnFromTheCursor(): void
    {
        $chat = $this->chatEntityManager()->find(Chat::class, Uuid::fromString($this->groupChat));
        self::assertInstanceOf(Chat::class, $chat);
        $this->messageAt($chat, 'needle', 0, 'The needle is here', sentAt: $this->at(-60));
        $entityManager = $this->chatEntityManager();
        $entityManager->wrapInTransaction(function (EntityManagerInterface $entityManager) use ($chat): void {
            for ($i = 0; $i < ChatReader::SEARCH_SCAN; ++$i) {
                $entityManager->persist($this->chatFields()->newMessage($chat, 'wa-filler-'.$i, false, $this->at(-59)->modify('+'.$i.' seconds'), null, 'Filler '.$i, null, null, null));
            }
        });
        $entityManager->clear();

        $first = $this->search(['q' => 'needle'], $this->reader);
        self::assertSame([], self::list($first['items'] ?? null));
        self::assertSame(ChatReader::SEARCH_SCAN, $first['scanned'] ?? null);
        self::assertFalse($first['complete'] ?? null, 'Stopped at the limit before the window\'s start.');
        $cursor = $first['nextCursor'] ?? null;
        self::assertIsString($cursor);

        $second = $this->search(['q' => 'needle', 'cursor' => $cursor], $this->reader);
        self::assertSame([$this->ids['needle']], array_column(self::list($second['items'] ?? null), 'id'));
        // Kim's five other messages are newer than the fillers, so the first call opened them and 1,995 fillers.
        self::assertSame(6, $second['scanned'] ?? null, 'The last five fillers and the needle.');
        self::assertTrue($second['complete'] ?? null);
    }

    /** In the tests: 8 searches in 10 minutes per caller, 12 per user. */
    public function testSearchesAreLimitedPerCallerAndPerUser(): void
    {
        for ($i = 0; $i < 8; ++$i) {
            $this->search(['q' => 'friday'], $this->reader);
        }
        $this->client->jsonRequest('POST', '/api/v1/chat-messages/search', ['q' => 'friday'], $this->reader);
        self::assertResponseStatusCodeSame(429, 'This caller used its share.');
        self::assertGreaterThan(0, (int) $this->client->getResponse()->headers->get('Retry-After'));

        $other = $this->seededThirdPartyHeaders('kim@example.test', ['chat:read']);
        for ($i = 0; $i < 4; ++$i) {
            $this->search(['q' => 'friday'], $other);
        }
        $this->client->jsonRequest('POST', '/api/v1/chat-messages/search', ['q' => 'friday'], $other);
        self::assertResponseStatusCodeSame(429, 'Another app of the same user has its own share, within the user\'s.');

        $lisa = $this->seededThirdPartyHeaders('lisa@example.test', ['chat:read']);
        self::assertSame([$this->ids['lisa']], array_column(self::list($this->search(['q' => 'friday'], $lisa)['items'] ?? null), 'id'), 'Another user has a limit of her own.');
    }

    public function testSearchIgnoresCaseAndUnicodeForms(): void
    {
        $chat = $this->chatEntityManager()->find(Chat::class, Uuid::fromString($this->annaChat));
        self::assertInstanceOf(Chat::class, $chat);
        $this->messageAt($chat, 'istanbul', 1, 'Flight to İstanbul on Monday');
        $this->messageAt($chat, 'cafe', 2, "Coffee at the cafe\u{0301} later");
        $this->messageAt($chat, 'strasse', 3, 'Meet at the Hauptstraße');

        self::assertSame([$this->ids['istanbul']], array_column(self::list($this->search(['q' => 'İSTANBUL'], $this->reader)['items'] ?? null), 'id'));
        self::assertSame([$this->ids['cafe']], array_column(self::list($this->search(['q' => "CAF\u{00C9}"], $this->reader)['items'] ?? null), 'id'), 'A decomposed é matches a composed one.');
        self::assertSame([$this->ids['strasse']], array_column(self::list($this->search(['q' => 'HAUPTSTRASSE'], $this->reader)['items'] ?? null), 'id'));
    }

    /**
     * @param array<string, string> $headers
     *
     * @return array<mixed>
     */
    private function get(string $path, array $headers): array
    {
        $this->client->request('GET', '/api/v1'.$path, server: $headers);
        self::assertResponseIsSuccessful($path.': '.$this->client->getResponse()->getContent());

        return $this->decodedResponse();
    }

    private static function asText(mixed $value): string
    {
        self::assertIsString($value);

        return $value;
    }

    /**
     * @return array<mixed>
     */
    private static function asMap(mixed $value): array
    {
        self::assertIsArray($value);

        return $value;
    }

    /**
     * @param array<string, mixed>  $body
     * @param array<string, string> $headers
     *
     * @return array<mixed>
     */
    private function search(array $body, array $headers): array
    {
        $this->client->jsonRequest('POST', '/api/v1/chat-messages/search', $body, $headers);
        self::assertResponseIsSuccessful('search: '.$this->client->getResponse()->getContent());

        return $this->decodedResponse();
    }

    /**
     * @return list<array<mixed>>
     */
    private static function list(mixed $value): array
    {
        self::assertIsArray($value);
        self::assertTrue(array_is_list($value));
        $list = [];
        foreach ($value as $item) {
            self::assertIsArray($item);
            $list[] = $item;
        }

        return $list;
    }
}
