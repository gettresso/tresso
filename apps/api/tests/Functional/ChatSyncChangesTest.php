<?php

declare(strict_types=1);

namespace App\Tests\Functional;

use App\Entity\Chat;
use App\Entity\User;
use App\Enum\ChatKind;
use App\Enum\ChatMediaKind;
use App\Security\Scope;
use Doctrine\ORM\EntityManagerInterface;
use PHPUnit\Framework\Attributes\DataProvider;
use Symfony\Bundle\FrameworkBundle\Console\Application;
use Symfony\Component\Console\Tester\CommandTester;
use Symfony\Component\Uid\Uuid;

/**
 * Chats reach our own apps through the delta, with their text opened so they read offline, and callers holding
 * chat:read. Any other caller gets the chat lists empty and none of their removals, while its cursor is the same.
 */
final class ChatSyncChangesTest extends DatabaseTestCase
{
    use AuthenticatesUsers;
    use ConnectsThirdPartyApps;
    use SeedsAccessTokens;
    use StoresChats;

    private const string JID = '31612345678@s.whatsapp.net';
    private const string GROUP_JID = '120363025246125486@g.us';

    /** @var array<string, string> */
    private array $kim;

    private string $accountId;
    private Chat $chat;
    private Chat $group;
    private string $waitingId;
    private string $cancelledId;

    protected function setUp(): void
    {
        parent::setUp();
        $this->bootstrapOAuthClients();
        $this->createUser('kim@example.test', 'Kim');
        $this->createUser('lisa@example.test', 'Lisa');
        $this->kim = $this->userHeaders('kim@example.test', ['mail:read', 'mail:write']);
        $this->client->jsonRequest('PUT', '/api/v1/chat-accounts/whatsapp', [
            'deviceId' => '0193a1c2-7b1e-7c3a-9f00-1b2c3d4e5f60',
            'deviceName' => 'Kim\'s MacBook Pro',
            'address' => '31698765432',
            'displayName' => 'Kim Visser',
        ], $this->userHeaders('kim@example.test', ['mail:read', 'mail:write'], 'desktop'));
        self::assertResponseStatusCodeSame(200);
        $this->accountId = $this->responseString('id');

        $account = $this->findChatAccount($this->accountId);
        $this->chat = $this->storeChat($account, self::JID, 'Anna de Vries');
        $this->group = $this->storeChat($account, self::GROUP_JID, 'Family', ChatKind::Group);
        $this->storeChatMessages($this->chat, [
            ['waId' => 'A1', 'text' => 'See you at the station at nine', 'sender' => ['id' => '31612345678', 'name' => 'Anna']],
            ['waId' => 'A2', 'text' => '', 'fromMe' => true, 'media' => [ChatMediaKind::Image, null, 183_000]],
        ]);
        $this->storeChatMessages($this->group, [['waId' => 'G1', 'text' => 'Dinner on Sunday?', 'sender' => ['id' => '31655555555', 'name' => null]]]);
        $this->waitingId = $this->storeChatOutgoing($this->chat, 'On my way')->getId()->toRfc4122();
        $this->cancelledId = $this->storeChatOutgoing($this->chat, 'Never mind')->getId()->toRfc4122();
        // However a reply came to be cancelled, the delta leaves it out.
        $this->connection()->executeStatement("UPDATE chat_outgoing SET status = 'cancelled' WHERE id = :id", ['id' => $this->cancelledId]);
        $this->chatEntityManager()->clear();
    }

    public function testOurAppsGetTheChatListsWithTheTextOpened(): void
    {
        $page = $this->delta(0, $this->kim);

        $this->client->request('GET', '/api/v1/chat-accounts', server: $this->kim);
        self::assertSame($this->decodedResponse(), $page['chatAccounts'], 'The delta and the resource give one shape.');

        $chats = array_column($page['chats'], null, 'id');
        self::assertSame([
            'id' => $this->chat->getId()->toRfc4122(),
            'chatAccountId' => $this->accountId,
            'jid' => self::JID,
            'name' => 'Anna de Vries',
            'kind' => 'direct',
            'lastMessageAt' => '2026-11-12T09:30:00+00:00',
            'readThrough' => null,
            'archivedThrough' => null,
            'leftOut' => false,
        ], $chats[$this->chat->getId()->toRfc4122()] ?? null);
        self::assertSame('group', $chats[$this->group->getId()->toRfc4122()]['kind'] ?? null);

        $messages = array_column($page['chatMessages'], null, 'waId');
        self::assertSame(['A1', 'A2', 'G1'], array_keys($messages));
        self::assertSame($this->chat->getId()->toRfc4122(), $messages['A1']['chatId']);
        self::assertSame($this->accountId, $messages['A1']['chatAccountId']);
        self::assertSame('See you at the station at nine', $messages['A1']['text']);
        self::assertSame(['id' => '31612345678', 'name' => 'Anna'], $messages['A1']['sender']);
        self::assertFalse($messages['A1']['fromMe']);
        self::assertSame('2026-11-12T09:00:00+00:00', $messages['A1']['sentAt']);
        self::assertNull($messages['A1']['mediaKind']);
        self::assertTrue($messages['A2']['fromMe']);
        self::assertNull($messages['A2']['sender']);
        self::assertSame('', $messages['A2']['text']);
        self::assertSame(['image', null, 183_000], [$messages['A2']['mediaKind'], $messages['A2']['mediaName'], $messages['A2']['mediaSize']]);
        self::assertSame(['id' => '31655555555', 'name' => null], $messages['G1']['sender']);

        self::assertSame([$this->waitingId], array_column($page['chatOutgoing'], 'id'), 'A cancelled reply is not listed.');
        self::assertSame('On my way', $page['chatOutgoing'][0]['text'] ?? null);
        self::assertSame('waiting', $page['chatOutgoing'][0]['status'] ?? null);
        self::assertArrayHasKey(0, $page['chatOutgoing']);
        self::assertArrayHasKey('error', $page['chatOutgoing'][0]);
        self::assertNull($page['chatOutgoing'][0]['error']);
    }

    /**
     * @return iterable<string, array{string}>
     */
    public static function callersThatAreNotOurs(): iterable
    {
        yield 'an app that is not ours' => ['third-party'];
        yield 'a personal access token' => ['personal access token'];
    }

    #[DataProvider('callersThatAreNotOurs')]
    public function testOtherCallersGetNoChatsWhileTheCursorIsTheSame(string $caller): void
    {
        $everything = array_map(static fn (Scope $scope): string => $scope->value, 'third-party' === $caller ? Scope::thirdPartyAppScopes() : Scope::personalAccessTokenScopes());
        $headers = 'third-party' === $caller
            ? $this->thirdPartyHeaders('kim@example.test', $everything)
            : $this->personalAccessTokenHeaders('kim@example.test', $everything);
        $ours = $this->delta(0, $this->kim);

        $theirs = $this->delta(0, $headers);

        self::assertSame($ours['cursor'], $theirs['cursor']);
        foreach (['chatAccounts', 'chats', 'chatMessages', 'chatOutgoing'] as $list) {
            self::assertNotSame([], $ours[$list], $list.' reaches our own app.');
            self::assertSame([], $theirs[$list], $list.' reaches our own apps only.');
        }

        $this->client->request('DELETE', '/api/v1/chat-accounts/'.$this->accountId, server: $this->kim);
        self::assertResponseStatusCodeSame(204);
        $removed = ['type' => 'chatAccount', 'id' => $this->accountId];
        self::assertContains($removed, $this->delta($ours['cursor'], $this->kim)['deleted']);
        $after = $this->delta($ours['cursor'], $headers);
        self::assertNotContains($removed, $after['deleted'], 'Not even that it was removed.');
        self::assertGreaterThan($ours['cursor'], $after['cursor']);
    }

    public function testAnAppHoldingChatReadGetsTheChatLists(): void
    {
        $ours = $this->delta(0, $this->kim);

        $theirs = $this->delta(0, $this->seededThirdPartyHeaders('kim@example.test', ['mail:read', 'chat:read']));

        self::assertSame($ours['cursor'], $theirs['cursor']);
        foreach (['chatAccounts', 'chats', 'chatMessages', 'chatOutgoing'] as $list) {
            self::assertSame($ours[$list], $theirs[$list], $list);
        }
        $lisa = $this->delta(0, $this->seededThirdPartyHeaders('lisa@example.test', ['mail:read', 'chat:read']));
        foreach (['chatAccounts', 'chats', 'chatMessages', 'chatOutgoing'] as $list) {
            self::assertSame([], $lisa[$list], 'Lisa\'s app sees none of Kim\'s '.$list);
        }
    }

    public function testChatSendAloneReadsNoChats(): void
    {
        $headers = $this->seededThirdPartyHeaders('kim@example.test', ['mail:read', 'chat:send']);
        $ours = $this->delta(0, $this->kim);

        $theirs = $this->delta(0, $headers);

        self::assertSame($ours['cursor'], $theirs['cursor']);
        foreach (['chatAccounts', 'chats', 'chatMessages', 'chatOutgoing'] as $list) {
            self::assertSame([], $theirs[$list], $list.' needs chat:read.');
        }

        $this->client->request('PATCH', '/api/v1/chat-accounts/'.$this->accountId, server: $this->kim + ['CONTENT_TYPE' => 'application/merge-patch+json'], content: '{"includeGroups":false}');
        self::assertResponseIsSuccessful();
        $this->client->request('DELETE', '/api/v1/chat-accounts/'.$this->accountId, server: $this->kim);
        self::assertResponseStatusCodeSame(204);
        self::assertSame(
            [['type' => 'chat', 'id' => $this->group->getId()->toRfc4122()], ['type' => 'chatAccount', 'id' => $this->accountId]],
            $this->delta($ours['cursor'], $this->kim)['deleted'],
        );
        $after = $this->delta($ours['cursor'], $headers);
        self::assertSame([], $after['deleted'], 'No removal of a chat or chat account either.');
        self::assertGreaterThan($ours['cursor'], $after['cursor']);
    }

    public function testPagingNeverSplitsAChangeNumber(): void
    {
        // Three more messages in one transaction: one change number.
        $this->storeChatMessages($this->chatInManager(), [
            ['waId' => 'B1', 'text' => 'one'],
            ['waId' => 'B2', 'text' => 'two'],
            ['waId' => 'B3', 'text' => 'three'],
        ]);
        $this->chatEntityManager()->clear();
        $full = $this->delta(0, $this->kim);
        $seen = [];
        $cursor = 0;
        $pages = 0;

        do {
            $page = $this->delta($cursor, $this->kim, 1);
            self::assertGreaterThan($cursor, $page['cursor']);
            $cursor = $page['cursor'];
            foreach (['chatAccounts', 'chats', 'chatMessages', 'chatOutgoing'] as $list) {
                foreach ($page[$list] as $entity) {
                    $seen[$list][] = $entity['id'];
                }
            }
            $batch = array_values(array_intersect(['B1', 'B2', 'B3'], array_filter(array_column($page['chatMessages'], 'waId'), is_string(...))));
            self::assertContains($batch, [[], ['B1', 'B2', 'B3']], 'One change number comes whole.');
            ++$pages;
        } while ($page['hasMore'] && $pages < 300);

        self::assertSame($full['cursor'], $cursor);
        self::assertGreaterThan(5, $pages);
        foreach (['chatAccounts', 'chats', 'chatMessages', 'chatOutgoing'] as $list) {
            self::assertEqualsCanonicalizing(array_column($full[$list], 'id'), $seen[$list] ?? [], $list.' differ between paged and full sync.');
        }
    }

    public function testAnUnchangedReconnectIsNoChangeForClients(): void
    {
        $cursor = $this->delta(0, $this->kim)['cursor'];

        $this->client->jsonRequest('PUT', '/api/v1/chat-accounts/whatsapp', [
            'deviceId' => '0193a1c2-7b1e-7c3a-9f00-1b2c3d4e5f60',
            'deviceName' => 'Kim\'s MacBook Pro',
            'address' => '31698765432',
            'displayName' => 'Kim Visser',
        ], $this->userHeaders('kim@example.test', ['mail:read', 'mail:write'], 'desktop'));
        self::assertResponseStatusCodeSame(200);

        self::assertSame($cursor, $this->delta($cursor, $this->kim)['cursor'], 'Only when it was last heard from changed.');
    }

    public function testRemovalsLeaveTombstones(): void
    {
        $cursor = $this->delta(0, $this->kim)['cursor'];

        $this->client->request('PATCH', '/api/v1/chat-accounts/'.$this->accountId, server: $this->kim + ['CONTENT_TYPE' => 'application/merge-patch+json'], content: '{"includeGroups":false}');
        self::assertResponseIsSuccessful();
        $page = $this->delta($cursor, $this->kim);
        self::assertSame([['type' => 'chat', 'id' => $this->group->getId()->toRfc4122()]], $page['deleted'], 'The group\'s messages go with it, as clients infer.');
        self::assertSame([$this->accountId], array_column($page['chatAccounts'], 'id'));
        self::assertFalse($page['chatAccounts'][0]['includeGroups']);

        $cursor = $page['cursor'];
        $this->client->request('DELETE', '/api/v1/chat-accounts/'.$this->accountId, server: $this->kim);
        self::assertResponseStatusCodeSame(204);
        self::assertSame([['type' => 'chatAccount', 'id' => $this->accountId]], $this->delta($cursor, $this->kim)['deleted'], 'One tombstone: everything under it is gone too.');
    }

    public function testUsersOnlySeeTheirOwnChats(): void
    {
        $lisa = $this->delta(0, $this->userHeaders('lisa@example.test', ['mail:read']));

        foreach (['chatAccounts', 'chats', 'chatMessages', 'chatOutgoing'] as $list) {
            self::assertSame([], $lisa[$list], $list);
        }
    }

    public function testDeletingTheUserLeavesNoChatRows(): void
    {
        $kim = $this->connection()->fetchOne("SELECT id FROM app_user WHERE email = 'kim@example.test'");
        self::assertIsString($kim);
        self::assertSame(['chat_account' => 1, 'chat' => 2, 'chat_message' => 3, 'chat_outgoing' => 2], $this->chatRowCounts());

        $tester = new CommandTester(new Application($this->client->getKernel())->find('app:users:delete'));
        $tester->execute(['email' => 'kim@example.test', '--force' => true]);

        $tester->assertCommandIsSuccessful();
        self::assertNull(static::getContainer()->get(EntityManagerInterface::class)->find(User::class, Uuid::fromString($kim)));
        self::assertSame(['chat_account' => 0, 'chat' => 0, 'chat_message' => 0, 'chat_outgoing' => 0], $this->chatRowCounts());
    }

    private function chatInManager(): Chat
    {
        $chat = $this->chatEntityManager()->find(Chat::class, $this->chat->getId());
        self::assertInstanceOf(Chat::class, $chat);

        return $chat;
    }

    /**
     * @param array<string, string> $headers
     *
     * @return array{cursor: int, hasMore: bool, chatAccounts: list<array<string, mixed>>, chats: list<array<string, mixed>>, chatMessages: list<array<string, mixed>>, chatOutgoing: list<array<string, mixed>>, deleted: list<array{type: string, id: string}>}
     */
    private function delta(int $since, array $headers, int $limit = 2000): array
    {
        $this->client->request('GET', \sprintf('/api/v1/sync/changes?since=%d&limit=%d', $since, $limit), server: $headers);
        self::assertResponseIsSuccessful();

        /** @var array{cursor: int, hasMore: bool, chatAccounts: list<array<string, mixed>>, chats: list<array<string, mixed>>, chatMessages: list<array<string, mixed>>, chatOutgoing: list<array<string, mixed>>, deleted: list<array{type: string, id: string}>} */
        return $this->decodedResponse();
    }
}
