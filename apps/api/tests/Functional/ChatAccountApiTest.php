<?php

declare(strict_types=1);

namespace App\Tests\Functional;

use App\Enum\ChatKind;
use App\Security\Scope;
use PHPUnit\Framework\Attributes\DataProvider;
use Symfony\Component\Uid\Uuid;

/**
 * The user's WhatsApp on the server: made by the desktop app that relays it, changed by our own apps only, and read by
 * our own apps or a caller holding chat:read. A personal access token or an app that is not ours (an MCP client among
 * them) without that scope never reaches it, whatever else it holds.
 */
final class ChatAccountApiTest extends DatabaseTestCase
{
    use AuthenticatesUsers;
    use ConnectsThirdPartyApps;
    use SeedsAccessTokens;
    use StoresChats;

    private const array MAIL = ['mail:read', 'mail:write'];
    private const string MAC = '0193a1c2-7b1e-7c3a-9f00-1b2c3d4e5f60';
    private const string OTHER_MAC = '0193a1c2-7b1e-7c3a-9f00-1b2c3d4e5f61';

    /** @var array<string, string> */
    private array $desktop;

    /** @var array<string, string> */
    private array $web;

    protected function setUp(): void
    {
        parent::setUp();
        $this->bootstrapOAuthClients();
        $this->createUser('kim@example.test', 'Kim');
        $this->createUser('lisa@example.test', 'Lisa');
        $this->desktop = $this->userHeaders('kim@example.test', self::MAIL, 'desktop');
        $this->web = $this->userHeaders('kim@example.test', self::MAIL);
    }

    public function testTheDesktopConnectsWhatsApp(): void
    {
        $this->connect();

        self::assertResponseStatusCodeSame(200);
        $account = $this->decodedResponse();
        self::assertIsString($account['id'] ?? null);
        self::assertTrue(Uuid::isValid($account['id']));
        self::assertSame([
            'id' => $account['id'],
            'channel' => 'whatsapp',
            'address' => '31698765432',
            'displayName' => 'Kim Visser',
            'relayDeviceId' => self::MAC,
            'relayDeviceName' => 'Kim\'s MacBook Pro',
            'relayOnline' => true,
            'relayOfflineSince' => null,
            'bridge' => 'running',
            'link' => 'unknown',
            'linkedAt' => null,
            'loopbackOnly' => null,
            'includeGroups' => true,
            'notify' => false,
        ], $account);

        $this->client->request('GET', '/api/v1/chat-accounts', server: $this->web);
        self::assertResponseIsSuccessful();
        self::assertSame([$account], $this->decodedResponse(), 'Every one of our apps reads it.');
        $this->client->request('GET', '/api/v1/chat-accounts', server: $this->userHeaders('kim@example.test', ['mail:read'], 'mobile'));
        self::assertSame([$account], $this->decodedResponse());

        $row = $this->connection()->fetchAssociative('SELECT sealed_address, sealed_display_name FROM chat_account');
        self::assertIsArray($row);
        self::assertIsString($row['sealed_address']);
        self::assertStringNotContainsString('31698765432', $row['sealed_address']);
        self::assertIsString($row['sealed_display_name']);
        self::assertStringNotContainsString('Kim Visser', $row['sealed_display_name']);
    }

    public function testConnectingFromAnotherDesktopTakesOverTheRelay(): void
    {
        $this->connect();
        $id = $this->responseString('id');

        $this->connect([
            'deviceId' => self::OTHER_MAC,
            'deviceName' => 'Kim\'s iMac',
            'address' => '31611112222',
            'displayName' => null,
            'includeGroups' => false,
            'notify' => true,
        ], $this->userHeaders('kim@example.test', self::MAIL, 'desktop'));

        self::assertResponseStatusCodeSame(200);
        $account = $this->decodedResponse();
        self::assertSame($id, $account['id'] ?? null, 'Still the one account.');
        self::assertSame(self::OTHER_MAC, $account['relayDeviceId'] ?? null);
        self::assertSame('Kim\'s iMac', $account['relayDeviceName'] ?? null);
        self::assertSame('31611112222', $account['address'] ?? null);
        self::assertArrayHasKey('displayName', $account);
        self::assertNull($account['displayName']);
        self::assertTrue($account['includeGroups'] ?? null, 'Taken when the account is made only.');
        self::assertFalse($account['notify'] ?? null, 'Taken when the account is made only.');
        self::assertSame(1, $this->countRows('SELECT COUNT(*) FROM chat_account'));
    }

    public function testADesktopLinkedToAnotherNumberCannotTakeOverAnAccountWithChats(): void
    {
        $this->connect();
        $id = $this->responseString('id');
        $this->storeChat($this->findChatAccount($id), '31612345678@s.whatsapp.net', 'Anna');
        $this->chatEntityManager()->clear();
        $other = ['deviceId' => self::OTHER_MAC, 'deviceName' => 'Kim\'s iMac', 'displayName' => null, 'includeGroups' => true, 'notify' => false];

        $this->connect($other + ['address' => '31611112222'], $this->userHeaders('kim@example.test', self::MAIL, 'desktop'));

        self::assertResponseStatusCodeSame(409);
        self::assertSame('other_number', $this->decodedResponse()['code'] ?? null);
        self::assertSame(self::MAC, $this->connection()->fetchOne('SELECT relay_device_id FROM chat_account'), 'The relay stays.');

        // The same number, or one the desktop does not know, takes over; an unknown one keeps the stored number.
        $this->connect($other + ['address' => null], $this->userHeaders('kim@example.test', self::MAIL, 'desktop'));
        self::assertResponseStatusCodeSame(200);
        self::assertSame(self::OTHER_MAC, $this->decodedResponse()['relayDeviceId'] ?? null);
        self::assertSame('31698765432', $this->decodedResponse()['address'] ?? null);
        $this->connect(self::connectBody());
        self::assertResponseStatusCodeSame(200);
        self::assertSame(self::MAC, $this->decodedResponse()['relayDeviceId'] ?? null);
    }

    /**
     * @return iterable<string, array{string}>
     */
    public static function otherOwnApps(): iterable
    {
        yield 'the web app' => ['web'];
        yield 'the mobile app' => ['mobile'];
    }

    #[DataProvider('otherOwnApps')]
    public function testOnlyTheDesktopAppConnects(string $client): void
    {
        $this->connect(headers: $this->userHeaders('kim@example.test', self::MAIL, $client));

        self::assertResponseStatusCodeSame(403, 'Only the desktop runs the bridge that relays.');
        self::assertSame(0, $this->countRows('SELECT COUNT(*) FROM chat_account'));
    }

    public function testConnectingNeedsMailWrite(): void
    {
        $this->connect(headers: $this->userHeaders('kim@example.test', ['mail:read'], 'desktop'));

        self::assertResponseStatusCodeSame(403);
    }

    /**
     * @return iterable<string, array{array<string, mixed>, string}>
     */
    public static function invalidConnections(): iterable
    {
        yield 'a device id that is no UUID' => [['deviceId' => 'my-mac'], 'deviceId'];
        yield 'no device name' => [['deviceName' => ' '], 'deviceName'];
        yield 'a device name that is too long' => [['deviceName' => str_repeat('a', 256)], 'deviceName'];
        yield 'an empty number' => [['address' => ''], 'address'];
        yield 'a number with a plus' => [['address' => '+31698765432'], 'address'];
        yield 'a number that is too short' => [['address' => '1234'], 'address'];
        yield 'a number that is too long' => [['address' => str_repeat('1', 21)], 'address'];
        yield 'a number with a new line' => [['address' => "31698765432\n"], 'address'];
        yield 'a name that is too long' => [['displayName' => str_repeat('a', 256)], 'displayName'];
        yield 'a device name with a line break' => [['deviceName' => "Kim's\nMacBook"], 'deviceName'];
        yield 'a device name that reverses text' => [['deviceName' => "Kim's \u{202E}kooBcaM"], 'deviceName'];
        yield 'a name with a control character' => [['displayName' => "Kim\u{0007}Visser"], 'displayName'];
        yield 'a name with a zero width joiner' => [['displayName' => "Kim\u{200D}Visser"], 'displayName'];
    }

    /**
     * @param array<string, mixed> $change
     */
    #[DataProvider('invalidConnections')]
    public function testRefusesAnInvalidConnection(array $change, string $path): void
    {
        $this->connect($change + self::connectBody());

        self::assertResponseStatusCodeSame(422);
        $violations = $this->decodedResponse()['violations'] ?? null;
        self::assertIsArray($violations);
        self::assertContains($path, array_column($violations, 'propertyPath'));
        self::assertSame(0, $this->countRows('SELECT COUNT(*) FROM chat_account'));
    }

    public function testAnUnknownNumberAndNameAreFine(): void
    {
        $this->connect(['address' => null, 'displayName' => null] + self::connectBody());

        self::assertResponseStatusCodeSame(200);
        $account = $this->decodedResponse();
        self::assertArrayHasKey('address', $account);
        self::assertNull($account['address']);
        self::assertNull($this->connection()->fetchOne('SELECT sealed_address FROM chat_account'));
    }

    public function testChangesNotifyAndIncludeGroups(): void
    {
        $this->connect();
        $id = $this->responseString('id');

        $this->patch($id, ['notify' => true], $this->web);

        self::assertResponseIsSuccessful();
        self::assertTrue($this->decodedResponse()['notify'] ?? null);
        self::assertTrue($this->decodedResponse()['includeGroups'] ?? null, 'A field left out stays.');
    }

    public function testLeavingGroupsOutRemovesTheGroupChats(): void
    {
        $this->connect();
        $id = $this->responseString('id');
        $account = $this->findChatAccount($id);
        $direct = $this->storeChat($account, '31612345678@s.whatsapp.net', 'Anna');
        $group = $this->storeChat($account, '120363025246125486@g.us', 'Family', ChatKind::Group);
        $this->storeChatMessages($group, [['waId' => 'G1', 'text' => 'Dinner on Sunday?'], ['waId' => 'G2', 'text' => 'Yes']]);
        $this->storeChatOutgoing($group, 'I bring dessert');
        $this->storeChatMessages($direct, [['waId' => 'D1', 'text' => 'Hi']]);
        $this->chatEntityManager()->clear();

        $this->patch($id, ['includeGroups' => false], $this->web);

        self::assertResponseIsSuccessful();
        self::assertFalse($this->decodedResponse()['includeGroups'] ?? null);
        self::assertSame([$direct->getId()->toRfc4122()], $this->connection()->fetchFirstColumn('SELECT id FROM chat'));
        self::assertSame(1, $this->countRows('SELECT COUNT(*) FROM chat_message'), 'The group\'s messages went with it.');
        self::assertSame(0, $this->countRows('SELECT COUNT(*) FROM chat_outgoing'));
        self::assertSame([$group->getId()->toRfc4122()], $this->connection()->fetchFirstColumn("SELECT entity_id FROM sync_tombstone WHERE entity_type = 'chat'"));
    }

    public function testDeletingTheAccountRemovesEverythingUnderIt(): void
    {
        $this->connect();
        $id = $this->responseString('id');
        $chat = $this->storeChat($this->findChatAccount($id), '31612345678@s.whatsapp.net', 'Anna');
        $this->storeChatMessages($chat, [['waId' => 'D1', 'text' => 'Hi']]);
        $this->storeChatOutgoing($chat, 'Hello');
        $this->chatEntityManager()->clear();

        $this->client->request('DELETE', '/api/v1/chat-accounts/'.$id, server: $this->web);

        self::assertResponseStatusCodeSame(204);
        self::assertSame(['chat_account' => 0, 'chat' => 0, 'chat_message' => 0, 'chat_outgoing' => 0, 'chat_upload' => 0], $this->chatRowCounts());
        $this->client->request('GET', '/api/v1/chat-accounts', server: $this->web);
        self::assertSame([], $this->decodedResponse());
    }

    public function testAnotherUsersAccountIsNotFound(): void
    {
        $this->connect();
        $id = $this->responseString('id');
        $lisa = $this->userHeaders('lisa@example.test', self::MAIL);

        $this->client->request('GET', '/api/v1/chat-accounts', server: $lisa);
        self::assertResponseIsSuccessful();
        self::assertSame([], $this->decodedResponse());
        $this->patch($id, ['notify' => true], $lisa);
        self::assertResponseStatusCodeSame(404);
        $this->client->request('DELETE', '/api/v1/chat-accounts/'.$id, server: $lisa);
        self::assertResponseStatusCodeSame(404);
        $this->client->request('GET', '/api/v1/chat_accounts/'.$id, server: $lisa);
        self::assertResponseStatusCodeSame(404);

        // Lisa's own WhatsApp is another account; Kim's is untouched.
        $this->connect(headers: $this->userHeaders('lisa@example.test', self::MAIL, 'desktop'));
        self::assertResponseStatusCodeSame(200);
        self::assertNotSame($id, $this->responseString('id'));
        $kims = $this->onlyAccount();
        self::assertSame($id, $kims['id'] ?? null);
        self::assertFalse($kims['notify'] ?? null);
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
    public function testCallersWithoutAChatScopeDoNotReachChatAccounts(string $caller): void
    {
        $this->connect();
        $id = $this->responseString('id');
        $everything = array_map(static fn (Scope $scope): string => $scope->value, Scope::thirdPartyDefaultScopes());
        $headers = 'third-party' === $caller
            ? $this->thirdPartyHeaders('kim@example.test', $everything)
            : $this->personalAccessTokenHeaders('kim@example.test', $everything);

        $this->client->request('GET', '/api/v1/chat-accounts', server: $headers);
        self::assertResponseStatusCodeSame(403);
        $this->connect(['deviceId' => self::OTHER_MAC] + self::connectBody(), $headers);
        self::assertResponseStatusCodeSame(403);
        $this->patch($id, ['includeGroups' => false, 'notify' => true], $headers);
        self::assertResponseStatusCodeSame(403);
        $this->client->request('DELETE', '/api/v1/chat-accounts/'.$id, server: $headers);
        self::assertResponseStatusCodeSame(403);

        $account = $this->onlyAccount();
        self::assertSame($id, $account['id'] ?? null);
        self::assertSame(self::MAC, $account['relayDeviceId'] ?? null);
        self::assertTrue($account['includeGroups'] ?? null);
        self::assertFalse($account['notify'] ?? null);
    }

    public function testAPersonalAccessTokenHoldsAChatScopeOnlyWhenTicked(): void
    {
        $this->connect();
        $session = $this->userHeaders('kim@example.test', ['settings:write', 'mail:read', 'mail:send']);
        $this->client->jsonRequest('POST', '/api/v1/personal-access-tokens', ['name' => 'Script', 'scopes' => ['mail:read']], $session);
        self::assertResponseStatusCodeSame(201);
        $mail = ['HTTP_AUTHORIZATION' => 'Bearer '.$this->responseString('token'), 'HTTP_ACCEPT' => 'application/json'];
        $this->client->jsonRequest('POST', '/api/v1/personal-access-tokens', ['name' => 'Chats', 'scopes' => ['chat:read']], $session);
        self::assertResponseStatusCodeSame(201);
        $chat = ['HTTP_AUTHORIZATION' => 'Bearer '.$this->responseString('token'), 'HTTP_ACCEPT' => 'application/json'];

        $this->client->request('GET', '/api/v1/chat-accounts', server: $mail);
        self::assertResponseStatusCodeSame(403, 'mail:read alone reaches no chat.');
        $this->client->request('GET', '/api/v1/chat-accounts', server: $chat);
        self::assertResponseIsSuccessful();
        self::assertCount(1, $this->decodedResponse());
    }

    public function testNeedsASignedInCaller(): void
    {
        $this->client->request('GET', '/api/v1/chat-accounts', server: ['HTTP_ACCEPT' => 'application/json']);

        self::assertResponseStatusCodeSame(401);
    }

    public function testAnAppHoldingChatReadReadsButChangesNothing(): void
    {
        $this->connect();
        $id = $this->responseString('id');
        $this->client->request('GET', '/api/v1/chat-accounts', server: $this->web);
        $ours = $this->decodedResponse();
        $headers = $this->seededThirdPartyHeaders('kim@example.test', ['chat:read']);

        $this->client->request('GET', '/api/v1/chat-accounts', server: $headers);
        self::assertResponseIsSuccessful();
        self::assertSame($ours, $this->decodedResponse());

        $this->connect(['deviceId' => self::OTHER_MAC] + self::connectBody(), $headers);
        self::assertResponseStatusCodeSame(403);
        $this->patch($id, ['includeGroups' => false, 'notify' => true], $headers);
        self::assertResponseStatusCodeSame(403);
        $this->client->request('DELETE', '/api/v1/chat-accounts/'.$id, server: $headers);
        self::assertResponseStatusCodeSame(403);
        self::assertSame($ours, [$this->onlyAccount()]);
    }

    public function testChatReadReachesOnlyTheOwnersChats(): void
    {
        $this->connect();
        $id = $this->responseString('id');
        $lisa = $this->seededThirdPartyHeaders('lisa@example.test', ['chat:read']);

        $this->client->request('GET', '/api/v1/chat-accounts', server: $lisa);
        self::assertResponseIsSuccessful();
        self::assertSame([], $this->decodedResponse());
        // chat:read changes no account at all, so the request is refused before any account is looked up.
        $this->patch($id, ['notify' => true], $lisa);
        self::assertResponseStatusCodeSame(403);
        $this->client->request('DELETE', '/api/v1/chat-accounts/'.$id, server: $lisa);
        self::assertResponseStatusCodeSame(403);
        self::assertFalse($this->onlyAccount()['notify'] ?? null);
    }

    /**
     * Kim's chat accounts, as our web app reads them: there is one.
     *
     * @return array<mixed>
     */
    private function onlyAccount(): array
    {
        $this->client->request('GET', '/api/v1/chat-accounts', server: $this->web);
        self::assertResponseIsSuccessful();
        $accounts = $this->decodedResponse();
        self::assertCount(1, $accounts);
        self::assertIsArray($accounts[0] ?? null);

        return $accounts[0];
    }

    /**
     * @param array<string, mixed>|null  $body
     * @param array<string, string>|null $headers
     */
    private function connect(?array $body = null, ?array $headers = null): void
    {
        $this->client->jsonRequest('PUT', '/api/v1/chat-accounts/whatsapp', $body ?? self::connectBody(), $headers ?? $this->desktop);
    }

    /**
     * @param array<string, mixed>  $change
     * @param array<string, string> $headers
     */
    private function patch(string $id, array $change, array $headers): void
    {
        $this->client->request('PATCH', '/api/v1/chat-accounts/'.$id, server: $headers + ['CONTENT_TYPE' => 'application/merge-patch+json'], content: json_encode($change, \JSON_THROW_ON_ERROR));
    }

    /** @return array<string, mixed> */
    private static function connectBody(): array
    {
        return [
            'deviceId' => self::MAC,
            'deviceName' => 'Kim\'s MacBook Pro',
            'address' => '31698765432',
            'displayName' => 'Kim Visser',
            'includeGroups' => true,
            'notify' => false,
        ];
    }
}
