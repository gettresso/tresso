<?php

declare(strict_types=1);

namespace App\Tests\Functional;

use App\Account\UserDeletion;
use App\Activity\PurgeAppActivity;
use App\Activity\PurgeAppActivityHandler;
use App\Entity\User;
use App\Tests\Functional\Mcp\TalksMcp;
use Symfony\Component\Clock\MockClock;
use Symfony\Component\Uid\Uuid;

/**
 * The activity log: what goes in (every MCP tool call and API request of an app that is not ours, refusals included,
 * never content), what stays out (our own apps, unknown callers), reading it (filters, paging, only one's own, only in
 * our own apps) and the purge after 90 days.
 */
final class AppActivityTest extends DatabaseTestCase
{
    use AuthenticatesUsers;
    use ConnectsThirdPartyApps;
    use TalksMcp;

    private User $kim;
    private User $lisa;

    protected function setUp(): void
    {
        parent::setUp();
        $this->bootstrapOAuthClients();
        $this->kim = $this->createUser('kim@example.test', 'Kim Visser');
        $this->lisa = $this->createUser('lisa@example.test', 'Lisa Bakker');
    }

    public function testAnApiRequestKeepsItsRouteTemplateAndNeverItsPathQueryOrBody(): void
    {
        $headers = $this->personalAccessTokenHeaders('kim@example.test', ['settings:read', 'settings:write']);
        $inbox = $this->builtinInbox($this->kim);
        $this->connection()->executeStatement('DELETE FROM app_activity');

        $this->client->request('GET', '/api/v1/mail-accounts?q=falcon-secret-query&filter=quarterly', server: $headers);
        self::assertResponseIsSuccessful();
        $this->client->request('PATCH', '/api/v1/smart-inboxes/'.$inbox, server: $headers + ['CONTENT_TYPE' => 'application/merge-patch+json'], content: json_encode([
            'instructions' => 'Mail about the Falcon takeover from anna@partner.example',
            'includeSenders' => ['anna@partner.example'],
        ], \JSON_THROW_ON_ERROR));
        self::assertResponseIsSuccessful();

        $rows = $this->rows();
        self::assertCount(2, $rows);
        $token = $this->connection()->fetchOne('SELECT id FROM personal_access_token WHERE owner_id = ?', [$this->kim->getId()->toRfc4122()]);
        self::assertIsString($token);

        self::assertSame([
            'owner_id' => $this->kim->getId()->toRfc4122(),
            'app_type' => 'token',
            'app_id' => $token,
            'channel' => 'api',
            'method' => 'GET',
            'action' => '/api/v1/mail-accounts',
            'kind' => 'read',
            'result' => 'done',
            'reason' => null,
            'scopes' => '["settings:read"]',
            'object_type' => 'MailAccount',
            'object_list' => true,
            'object_id' => null,
        ], $this->withoutVolatile($rows[0]));
        self::assertSame([
            'owner_id' => $this->kim->getId()->toRfc4122(),
            'app_type' => 'token',
            'app_id' => $token,
            'channel' => 'api',
            'method' => 'PATCH',
            'action' => '/api/v1/smart-inboxes/{id}',
            'kind' => 'change',
            'result' => 'done',
            'reason' => null,
            'scopes' => '["settings:write"]',
            'object_type' => 'SmartInbox',
            'object_list' => false,
            'object_id' => $inbox,
        ], $this->withoutVolatile($rows[1]));
        $this->assertHoldsNone($rows, ['falcon', 'quarterly', 'anna', 'partner.example', 'takeover', '?', 'tresso_pat_']);
    }

    public function testAToolCallKeepsTheToolAndWhatItTouchedAndNeverItsArgumentsOrAnswer(): void
    {
        $headers = $this->thirdPartyHeaders('kim@example.test', ['settings:read', 'settings:write']);
        $session = $this->mcpInitialize($headers);
        $inbox = $this->builtinInbox($this->kim);
        $this->connection()->executeStatement('DELETE FROM app_activity');

        $this->mcpCallOk($headers, $session, 'update_smart_inbox', ['id' => $inbox, 'instructions' => 'Mail about the Falcon takeover']);
        $this->mcpCallOk($headers, $session, 'add_smart_inbox_senders', ['id' => $inbox, 'senders' => ['anna@partner.example']]);
        $this->mcpCallOk($headers, $session, 'list_smart_inboxes');

        $rows = $this->rows();
        self::assertSame(['update_smart_inbox', 'add_smart_inbox_senders', 'list_smart_inboxes'], array_column($rows, 'action'), 'One entry per tool call; the MCP request itself and the sub-requests are not entries.');
        $client = $this->connection()->fetchOne('SELECT client_id FROM oauth_consent WHERE user_id = ?', [$this->kim->getId()->toRfc4122()]);
        self::assertIsString($client);
        self::assertSame([
            'owner_id' => $this->kim->getId()->toRfc4122(),
            'app_type' => 'client',
            'app_id' => rtrim($client),
            'channel' => 'mcp',
            'method' => null,
            'action' => 'update_smart_inbox',
            'kind' => 'change',
            'result' => 'done',
            'reason' => null,
            'scopes' => '["settings:write"]',
            'object_type' => 'SmartInbox',
            'object_list' => false,
            'object_id' => $inbox,
        ], $this->withoutVolatile($rows[0]));
        self::assertSame(['SmartInbox', $inbox, '["settings:read","settings:write"]'], [$rows[1]['object_type'], $rows[1]['object_id'], $rows[1]['scopes']], 'The last operation that named an object: the inbox it changed.');
        self::assertSame(['read', 'SmartInbox', true, null], [$rows[2]['kind'], $rows[2]['object_type'], $rows[2]['object_list'], $rows[2]['object_id']]);
        $this->assertHoldsNone($rows, ['falcon', 'takeover', 'anna', 'partner.example', 'instructions']);
    }

    public function testRefusalsAreLoggedForCallersWeCanName(): void
    {
        // A tool the connection has no scope for.
        $headers = $this->thirdPartyHeaders('kim@example.test', ['settings:read']);
        $session = $this->mcpInitialize($headers);
        $this->mcpCallError($headers, $session, 'list_whatsapp_chats');
        // An API operation the token has no scope for, and one only our own apps may use.
        $token = $this->personalAccessTokenHeaders('kim@example.test', ['signatures:read']);
        $this->client->request('GET', '/api/v1/mail-accounts', server: $token);
        self::assertResponseStatusCodeSame(403);
        $this->client->request('GET', '/api/v1/connected-apps', server: $token);
        self::assertResponseStatusCodeSame(403);
        $this->client->request('GET', '/api/v1/smart-inboxes/'.Uuid::v7()->toRfc4122(), server: $this->personalAccessTokenHeaders('kim@example.test', ['settings:read']));
        self::assertResponseStatusCodeSame(404);

        $rows = array_values(array_filter($this->rows(), static fn (array $row): bool => 'done' !== $row['result']));
        self::assertSame([
            ['mcp', 'list_whatsapp_chats', 'refused', 'no_permission', '["chat:read"]'],
            ['api', '/api/v1/mail-accounts', 'refused', 'no_permission', '["settings:read"]'],
            ['api', '/api/v1/connected-apps', 'refused', 'no_permission', '["settings:read"]'],
            ['api', '/api/v1/smart-inboxes/{id}', 'refused', 'not_found', '["settings:read"]'],
        ], array_map(static fn (array $row): array => [$row['channel'], $row['action'], $row['result'], $row['reason'], $row['scopes']], $rows));
    }

    public function testAnExpiredOrRevokedTokenIsLoggedAndAnUnknownOneIsNot(): void
    {
        $expired = $this->personalAccessTokenHeaders('kim@example.test', ['settings:read']);
        $this->connection()->executeStatement("UPDATE personal_access_token SET expires_at = NOW() - INTERVAL '1 day'");
        $revoked = $this->personalAccessTokenHeaders('kim@example.test', ['settings:read']);
        $this->connection()->executeStatement('UPDATE personal_access_token SET revoked_at = NOW() WHERE revoked_at IS NULL AND expires_at > NOW()');
        $this->connection()->executeStatement('DELETE FROM app_activity');

        foreach ([$expired, $revoked, ['HTTP_AUTHORIZATION' => 'Bearer tresso_pat_nobody-knows-this-one', 'HTTP_ACCEPT' => 'application/json'], ['HTTP_ACCEPT' => 'application/json']] as $headers) {
            $this->client->request('GET', '/api/v1/mail-accounts/'.Uuid::v7()->toRfc4122(), server: $headers);
            self::assertResponseStatusCodeSame(401);
        }

        $rows = $this->rows();
        self::assertSame([['token_expired', 'refused'], ['access_revoked', 'refused']], array_map(static fn (array $row): array => [$row['reason'], $row['result']], $rows));
        self::assertSame(['/api/v1/mail-accounts/{id}', '/api/v1/mail-accounts/{id}'], array_column($rows, 'action'));
        self::assertSame([$this->kim->getId()->toRfc4122(), $this->kim->getId()->toRfc4122()], array_column($rows, 'owner_id'));
    }

    public function testATokenOfADisconnectedAppIsLoggedAsRevoked(): void
    {
        $headers = $this->thirdPartyHeaders('kim@example.test', ['settings:read']);
        $this->client->request('GET', '/api/v1/mail-accounts', server: $headers);
        self::assertResponseIsSuccessful();
        $consent = $this->connection()->fetchOne('SELECT id FROM oauth_consent WHERE user_id = ?', [$this->kim->getId()->toRfc4122()]);
        self::assertIsString($consent);
        $this->client->request('DELETE', '/api/v1/connected-apps/'.$consent, server: $this->userHeaders('kim@example.test', ['settings:write']));
        self::assertResponseStatusCodeSame(204);
        $this->connection()->executeStatement('DELETE FROM app_activity');

        $this->client->request('GET', '/api/v1/mail-accounts', server: $headers);
        self::assertResponseStatusCodeSame(401);

        self::assertSame([['client', 'access_revoked', '/api/v1/mail-accounts']], array_map(static fn (array $row): array => [$row['app_type'], $row['reason'], $row['action']], $this->rows()));
    }

    public function testOurOwnAppsAreNotLogged(): void
    {
        $this->connection()->executeStatement('DELETE FROM app_activity');
        foreach (['web', 'desktop', 'mobile'] as $client) {
            $this->client->request('GET', '/api/v1/mail-accounts', server: $this->userHeaders('kim@example.test', ['settings:read'], $client));
            self::assertResponseIsSuccessful();
        }

        self::assertSame([], $this->rows());
    }

    public function testTheLogIsReadNewestFirstWithItsDetailsFiltersAndPages(): void
    {
        $headers = $this->thirdPartyHeaders('kim@example.test', ['settings:read', 'signatures:read']);
        $session = $this->mcpInitialize($headers);
        $this->connection()->executeStatement('DELETE FROM app_activity');
        $this->mcpCallOk($headers, $session, 'list_mail_accounts');
        $this->mcpCallError($headers, $session, 'list_whatsapp_chats');
        $this->client->request('GET', '/api/v1/signatures', server: $headers);
        self::assertResponseIsSuccessful();
        // An older entry of the app, 10 days ago, and one of Lisa's.
        $client = $this->rows()[0]['app_id'];
        self::assertIsString($client);
        $this->insertEntry($this->kim, new \DateTimeImmutable('-10 days'), 'client', $client, 'get_me');
        $this->insertEntry($this->lisa, new \DateTimeImmutable('-1 hour'), 'client', $client, 'get_me');

        $web = $this->userHeaders('kim@example.test', ['settings:read']);
        $page = $this->read($web, ['period' => '24h']);
        self::assertSame(['GET /api/v1/signatures', 'list_whatsapp_chats', 'list_mail_accounts'], array_column(array_column($page['items'], 'action'), 'name'));
        self::assertNull($page['nextCursor']);

        $consent = $this->connection()->fetchOne('SELECT id FROM oauth_consent WHERE user_id = ?', [$this->kim->getId()->toRfc4122()]);
        $refused = $page['items'][1];
        self::assertSame([
            'key' => 'client:'.$client,
            'type' => 'client',
            'name' => 'Some app',
            'connectedAppId' => $consent,
            'personalAccessTokenId' => null,
        ], $refused['app']);
        self::assertSame('mcp', $refused['channel']);
        self::assertSame(['name' => 'list_whatsapp_chats', 'title' => 'List WhatsApp chats'], $refused['action']);
        self::assertSame(['read', 'refused'], [$refused['kind'], $refused['result']]);
        self::assertSame([
            'code' => 'no_permission',
            'label' => 'No permission',
            'sentence' => 'Some app does not have the permission Read your WhatsApp chats. Nothing was read.',
        ], $refused['reason']);
        self::assertSame([['scope' => 'chat:read', 'label' => 'Read your WhatsApp chats', 'held' => false]], $refused['permissions']);
        self::assertNull($refused['object']);

        $api = $page['items'][0];
        self::assertSame(['name' => 'GET /api/v1/signatures', 'title' => 'List signatures'], $api['action']);
        self::assertSame(['type' => 'Signature', 'label' => 'Signatures', 'list' => true, 'id' => null], $api['object']);
        self::assertSame([['scope' => 'signatures:read', 'label' => 'See signatures', 'held' => true]], $api['permissions']);
        self::assertSame('api', $api['channel']);
        self::assertIsInt($api['durationMs']);
        self::assertSame([['key' => 'client:'.$client, 'type' => 'client', 'name' => 'Some app']], $page['apps']);

        self::assertCount(4, $this->read($web, ['period' => '30d'])['items'], 'The older entry is in a longer period; Lisa\'s never.');
        self::assertCount(4, $this->read($web, [])['items'], '90 days unless asked otherwise.');
        self::assertSame(['list_whatsapp_chats'], array_column(array_column($this->read($web, ['result' => 'refused'])['items'], 'action'), 'name'));
        self::assertSame(['GET /api/v1/signatures', 'list_mail_accounts'], array_column(array_column($this->read($web, ['period' => '24h', 'kind' => 'read', 'result' => 'done', 'app' => 'client:'.$client])['items'], 'action'), 'name'));
        self::assertSame([], $this->read($web, ['kind' => 'send'])['items']);
        self::assertSame([], $this->read($web, ['app' => 'token:'.Uuid::v7()->toRfc4122()])['items']);

        // Paging: one at a time, newest first, until the last page.
        $names = [];
        $cursor = null;
        do {
            $page = $this->read($web, ['limit' => '1'] + (null === $cursor ? [] : ['cursor' => $cursor]));
            self::assertLessThanOrEqual(1, \count($page['items']));
            $names = [...$names, ...array_column(array_column($page['items'], 'action'), 'name')];
            $cursor = $page['nextCursor'];
        } while (null !== $cursor);
        self::assertSame(['GET /api/v1/signatures', 'list_whatsapp_chats', 'list_mail_accounts', 'get_me'], $names);

        // Lisa sees only her own entry.
        self::assertSame(['get_me'], array_column(array_column($this->read($this->userHeaders('lisa@example.test', ['settings:read']), [])['items'], 'action'), 'name'));
    }

    public function testTheFiltersAreChecked(): void
    {
        $web = $this->userHeaders('kim@example.test', ['settings:read']);
        foreach ([['period' => '1y'], ['kind' => 'delete'], ['result' => 'ok'], ['app' => 'someone'], ['limit' => '0'], ['limit' => '101'], ['cursor' => 'not-a-cursor']] as $query) {
            $this->client->request('GET', '/api/v1/app-activity?'.http_build_query($query), server: $web);
            self::assertResponseStatusCodeSame(422, (string) json_encode($query));
        }
    }

    public function testOnlyOurOwnAppsMayReadTheLog(): void
    {
        $this->client->request('GET', '/api/v1/app-activity', server: $this->personalAccessTokenHeaders('kim@example.test', ['settings:read']));
        self::assertResponseStatusCodeSame(403);
        $this->client->request('GET', '/api/v1/app-activity', server: $this->thirdPartyHeaders('kim@example.test', ['settings:read']));
        self::assertResponseStatusCodeSame(403);
        $this->client->request('GET', '/api/v1/app-activity', server: $this->userHeaders('kim@example.test', ['mail:read']));
        self::assertResponseStatusCodeSame(403, 'settings:read is needed.');
        $this->client->request('GET', '/api/v1/app-activity', server: ['HTTP_ACCEPT' => 'application/json']);
        self::assertResponseStatusCodeSame(401);
    }

    public function testEntriesGoAfter90DaysInBatches(): void
    {
        $now = new \DateTimeImmutable('2026-11-24 12:00:00');
        foreach (['-91 days', '-90 days -1 minute', '-89 days', '-1 hour'] as $age) {
            $this->insertEntry($this->kim, $now->modify($age), 'client', 'claude-test', 'get_me');
        }
        $handler = new PurgeAppActivityHandler($this->connection(), new MockClock($now));

        self::assertSame(2, $handler(new PurgeAppActivity()));
        self::assertSame(2, $this->countRows('SELECT COUNT(*) FROM app_activity'));
        self::assertSame(0, $handler(new PurgeAppActivity()));

        for ($i = 0; $i < PurgeAppActivityHandler::BATCH + 3; ++$i) {
            $this->insertEntry($this->lisa, $now->modify('-100 days'), 'client', 'claude-test', 'get_me');
        }
        self::assertSame(PurgeAppActivityHandler::BATCH + 3, $handler(new PurgeAppActivity()), 'It runs batch after batch until nothing older is left.');
        self::assertSame(2, $this->countRows('SELECT COUNT(*) FROM app_activity'));
    }

    public function testDeletingAUserDeletesTheirEntries(): void
    {
        $this->insertEntry($this->kim, new \DateTimeImmutable('-1 hour'), 'client', 'claude-test', 'get_me');
        $this->insertEntry($this->lisa, new \DateTimeImmutable('-1 hour'), 'client', 'claude-test', 'get_me');

        static::getContainer()->get(UserDeletion::class)->delete($this->kim->getId());

        self::assertSame(0, $this->countRows('SELECT COUNT(*) FROM app_activity WHERE owner_id = :owner', ['owner' => $this->kim->getId()->toRfc4122()]));
        self::assertSame(1, $this->countRows('SELECT COUNT(*) FROM app_activity WHERE owner_id = :owner', ['owner' => $this->lisa->getId()->toRfc4122()]));
    }

    public function testTheMcpEndpointIsInTheServerInfo(): void
    {
        $this->client->request('GET', '/api/v1/server-info', server: ['HTTP_ACCEPT' => 'application/json']);
        self::assertResponseIsSuccessful();
        self::assertSame('http://localhost/mcp', $this->decodedResponse()['mcpEndpoint'] ?? null);
    }

    /**
     * @param array<string, string> $headers
     * @param array<string, string> $query
     *
     * @return array{items: list<array<string, mixed>>, nextCursor: string|null, apps: list<array<string, mixed>>}
     */
    private function read(array $headers, array $query): array
    {
        $this->client->request('GET', '/api/v1/app-activity'.([] === $query ? '' : '?'.http_build_query($query)), server: $headers);
        self::assertResponseIsSuccessful((string) $this->client->getResponse()->getContent());
        /** @var array{items: list<array<string, mixed>>, nextCursor: string|null, apps: list<array<string, mixed>>} */
        return $this->decodedResponse();
    }

    /**
     * Every entry, oldest first.
     *
     * @return list<array<string, mixed>>
     */
    private function rows(): array
    {
        /** @var list<array<string, mixed>> */
        return $this->connection()->fetchAllAssociative('SELECT * FROM app_activity ORDER BY occurred_at, id');
    }

    /**
     * @param array<string, mixed> $row
     *
     * @return array<string, mixed>
     */
    private function withoutVolatile(array $row): array
    {
        self::assertIsInt($row['duration_ms']);
        self::assertGreaterThanOrEqual(0, $row['duration_ms']);
        self::assertIsString($row['id']);
        self::assertTrue(Uuid::isValid($row['id']));
        self::assertIsString($row['occurred_at']);
        self::assertNotFalse(\DateTimeImmutable::createFromFormat('Y-m-d H:i:s', $row['occurred_at']));
        self::assertIsString($row['app_id']);
        unset($row['id'], $row['occurred_at'], $row['duration_ms']);
        $row['app_id'] = rtrim($row['app_id']);

        return ['owner_id' => $row['owner_id']] + $row;
    }

    /**
     * No stored value holds any of these, in any column, in any case.
     *
     * @param list<array<string, mixed>> $rows
     * @param list<string>               $needles
     */
    private function assertHoldsNone(array $rows, array $needles): void
    {
        $stored = mb_strtolower((string) json_encode($rows, \JSON_UNESCAPED_SLASHES | \JSON_UNESCAPED_UNICODE));
        foreach ($needles as $needle) {
            self::assertStringNotContainsString(mb_strtolower($needle), $stored, \sprintf('The log holds "%s".', $needle));
        }
    }

    private function builtinInbox(User $owner): string
    {
        $id = $this->connection()->fetchOne('SELECT id FROM category WHERE owner_id = ? AND builtin IS NOT NULL ORDER BY position LIMIT 1', [$owner->getId()->toRfc4122()]);
        self::assertIsString($id);

        return $id;
    }

    private function insertEntry(User $owner, \DateTimeImmutable $at, string $appType, string $appId, string $tool): void
    {
        $this->connection()->insert('app_activity', [
            'id' => Uuid::v7()->toRfc4122(),
            'owner_id' => $owner->getId()->toRfc4122(),
            'occurred_at' => $at->format('Y-m-d H:i:s'),
            'app_type' => $appType,
            'app_id' => $appId,
            'channel' => 'mcp',
            'method' => null,
            'action' => $tool,
            'kind' => 'read',
            'result' => 'done',
            'reason' => null,
            'duration_ms' => 5,
            'scopes' => '[]',
            'object_type' => null,
            'object_list' => 'false',
            'object_id' => null,
        ]);
    }
}
