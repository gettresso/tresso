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
        foreach (['chat:read' => $this->reader, 'chat:send' => $this->seededThirdPartyHeaders('kim@example.test', ['chat:send'])] as $scope => $headers) {
            $status = $this->get('/chat-accounts/whatsapp/status', $headers);

            self::assertSame([
                'channel' => 'whatsapp',
                'onServer' => true,
                'chatAccountId' => $this->kimsAccount->getId()->toRfc4122(),
                'relayDeviceName' => 'Kim\'s MacBook Pro',
                'relayOnline' => true,
                'relayOfflineSince' => null,
                'bridge' => 'running',
                'link' => 'unknown',
            ], $status, $scope);
            self::assertStringNotContainsString('31698765432', (string) $this->client->getResponse()->getContent(), 'The own number stays out.');
            self::assertStringNotContainsString('Kim Visser', (string) $this->client->getResponse()->getContent(), 'The own name stays out.');
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
            foreach (['/chat-accounts/whatsapp/status', '/chats', '/chats/'.$this->annaChat.'/messages', '/chat-messages/search?q=friday'] as $path) {
                $this->client->request('GET', '/api/v1'.$path, server: $headers);
                self::assertResponseStatusCodeSame(403, $caller.': '.$path);
            }
        }
        foreach (['/chats', '/chats/'.$this->annaChat.'/messages', '/chat-messages/search?q=friday'] as $path) {
            $this->client->request('GET', '/api/v1'.$path, server: $send);
            self::assertResponseStatusCodeSame(403, 'chat:send reads nothing: '.$path);
            self::assertStringNotContainsString('Anna', (string) $this->client->getResponse()->getContent());
        }
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

    public function testParametersOutOfRangeAndForeignCursorsAreRefused(): void
    {
        foreach (['/chats?limit=0' => 'limit', '/chats?limit=101' => 'limit', '/chats?limit=ten' => 'limit', '/chats/'.$this->annaChat.'/messages?limit=500' => 'limit', '/chat-messages/search?q=a' => 'q', '/chat-messages/search?q=friday&days=91' => 'days', '/chat-messages/search?q=friday&limit=51' => 'limit', '/chat-messages/search?q='.str_repeat('x', 201) => 'q', '/chat-messages/search?q=fri%01day' => 'q'] as $path => $field) {
            $this->client->request('GET', '/api/v1'.$path, server: $this->reader);
            self::assertResponseStatusCodeSame(422, $path);
            self::assertSame([$field], array_column(self::list($this->decodedResponse()['violations'] ?? null), 'propertyPath'), $path);
        }
        foreach (['/chats?cursor=nonsense', '/chats/'.$this->annaChat.'/messages?cursor='.base64_encode('["x",0,"y"]'), '/chat-messages/search?q=friday&cursor=AAAA'] as $path) {
            $this->client->request('GET', '/api/v1'.$path, server: $this->reader);
            self::assertResponseStatusCodeSame(400, $path);
        }
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

            $this->client->request('GET', '/api/v1/chat-messages/search?q=friday&chatId='.$chat, server: $this->reader);
            self::assertResponseStatusCodeSame(404, $chat);
        }
    }

    public function testSearchLooksInTextFileNamesAndSendersIgnoringCase(): void
    {
        $friday = $this->get('/chat-messages/search?q=FRIDAY', $this->reader);
        self::assertSame([$this->ids['friday']], array_column(self::list($friday['items'] ?? null), 'id'), 'Not the chat left out, not Lisa\'s.');
        $hit = self::list($friday['items'] ?? null)[0];
        self::assertSame(['Anna de Vries', 'direct', $this->annaChat, 'Are we still on for Friday?'], [$hit['chatName'] ?? null, $hit['chatKind'] ?? null, $hit['chatId'] ?? null, $hit['text'] ?? null]);
        self::assertTrue($friday['complete'] ?? null);
        self::assertArrayHasKey('nextCursor', $friday);

        self::assertNull($friday['nextCursor']);
        self::assertSame(5, $friday['scanned'] ?? null, 'Kim\'s messages in the chats she keeps.');
        self::assertSame(ChatReader::SEARCH_SCAN, $friday['scanLimit'] ?? null);
        self::assertSame($this->at(0)->format(\DATE_ATOM), $friday['searchedThrough'] ?? null);

        self::assertSame([$this->ids['agenda']], array_column(self::list($this->get('/chat-messages/search?q=agenda.PDF', $this->reader)['items'] ?? null), 'id'));
        self::assertSame([$this->ids['morning']], array_column(self::list($this->get('/chat-messages/search?q=bram', $this->reader)['items'] ?? null), 'id'));
        self::assertSame([], self::list($this->get('/chat-messages/search?q=bram&chatId='.$this->annaChat, $this->reader)['items'] ?? null));
        self::assertSame([$this->ids['see-you'], $this->ids['agenda'], $this->ids['friday']], array_column(self::list($this->get('/chat-messages/search?q=anna&chatId='.$this->annaChat, $this->reader)['items'] ?? null), 'id'), 'Newest first, by sender name.');
    }

    public function testSearchKeepsToItsWindow(): void
    {
        $chat = $this->chatEntityManager()->find(Chat::class, Uuid::fromString($this->annaChat));
        self::assertInstanceOf(Chat::class, $chat);
        $this->messageAt($chat, 'ancient', 0, 'An ancient plan', sentAt: new \DateTimeImmutable('-40 days'));

        $recent = $this->get('/chat-messages/search?q=ancient', $this->reader);
        self::assertSame([], self::list($recent['items'] ?? null));
        self::assertTrue($recent['complete'] ?? null);

        self::assertSame([$this->ids['ancient']], array_column(self::list($this->get('/chat-messages/search?q=ancient&days=45', $this->reader)['items'] ?? null), 'id'));
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

        $first = $this->get('/chat-messages/search?q=needle', $this->reader);
        self::assertSame([], self::list($first['items'] ?? null));
        self::assertSame(ChatReader::SEARCH_SCAN, $first['scanned'] ?? null);
        self::assertFalse($first['complete'] ?? null, 'Stopped at the limit before the window\'s start.');
        $cursor = $first['nextCursor'] ?? null;
        self::assertIsString($cursor);

        $second = $this->get('/chat-messages/search?q=needle&cursor='.$cursor, $this->reader);
        self::assertSame([$this->ids['needle']], array_column(self::list($second['items'] ?? null), 'id'));
        // Kim's five other messages are newer than the fillers, so the first call opened them and 1,995 fillers.
        self::assertSame(6, $second['scanned'] ?? null, 'The last five fillers and the needle.');
        self::assertTrue($second['complete'] ?? null);
    }

    public function testSearchesAreLimitedPerUser(): void
    {
        for ($i = 0; $i < 12; ++$i) {
            $this->get('/chat-messages/search?q=friday', $this->reader);
        }

        $this->client->request('GET', '/api/v1/chat-messages/search?q=friday', server: $this->reader);
        self::assertResponseStatusCodeSame(429);
        self::assertGreaterThan(0, (int) $this->client->getResponse()->headers->get('Retry-After'));

        $lisa = $this->seededThirdPartyHeaders('lisa@example.test', ['chat:read']);
        self::assertSame([$this->ids['lisa']], array_column(self::list($this->get('/chat-messages/search?q=friday', $lisa)['items'] ?? null), 'id'), 'Another user has a limit of her own.');
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
