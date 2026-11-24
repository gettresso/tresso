<?php

declare(strict_types=1);

namespace App\Tests\Functional;

use App\Tests\Functional\Mcp\TalksMcp;
use Symfony\Component\Uid\Uuid;

/**
 * Narrowing a connected app: PATCH /api/v1/connected-apps/{id} switches granted scopes off and on again, takes effect
 * on the next request with tokens the app already holds, never widens past what the consent screen granted, and only
 * our own apps may do it.
 */
final class ConnectedAppPermissionsTest extends DatabaseTestCase
{
    use AuthenticatesUsers;
    use ConnectsThirdPartyApps;
    use TalksMcp;

    protected function setUp(): void
    {
        parent::setUp();
        $this->bootstrapOAuthClients();
        $this->createUser('kim@example.test', 'Kim Visser');
        $this->createUser('lisa@example.test', 'Lisa Bakker');
    }

    public function testTheListShowsWhatWasGrantedAndWhatIsAllowed(): void
    {
        $this->thirdPartyHeaders('kim@example.test', ['settings:read', 'signatures:read']);
        $app = $this->connectedApp();

        self::assertSame(['settings:read', 'signatures:read'], $app['scopes']);
        self::assertSame(['settings:read', 'signatures:read'], $app['grantedScopes']);
        $client = $this->connection()->fetchOne('SELECT client_id FROM oauth_consent');
        self::assertIsString($client);
        self::assertSame('client:'.rtrim($client), $app['activityKey']);
    }

    public function testASwitchedOffScopeIsRefusedAtOnceWithTheTokenTheAppHolds(): void
    {
        $headers = $this->thirdPartyHeaders('kim@example.test', ['settings:read', 'signatures:read']);
        $session = $this->mcpInitialize($headers);
        self::assertContains('list_signatures', $this->mcpToolNames($headers, $session));
        $id = $this->connectedAppId();

        $this->narrow($id, ['settings:read']);
        self::assertResponseIsSuccessful();
        self::assertSame(['settings:read'], $this->decodedResponse()['scopes'] ?? null);
        self::assertSame(['settings:read', 'signatures:read'], $this->decodedResponse()['grantedScopes'] ?? null);

        $this->client->request('GET', '/api/v1/signatures', server: $headers);
        self::assertResponseStatusCodeSame(403, 'The token the app already holds lost the scope.');
        $this->client->request('GET', '/api/v1/mail-accounts', server: $headers);
        self::assertResponseIsSuccessful('What is still allowed keeps working.');
        self::assertNotContains('list_signatures', $this->mcpToolNames($headers, $session));
        self::assertContains('list_mail_accounts', $this->mcpToolNames($headers, $session));
        $error = $this->mcpCallError($headers, $session, 'list_signatures');
        self::assertStringContainsString('which the user switched off for this app in Tresso', $error);

        $refused = $this->connection()->fetchAllAssociative("SELECT channel, action, reason FROM app_activity WHERE result = 'refused' ORDER BY occurred_at, id");
        self::assertSame([
            ['channel' => 'api', 'action' => '/api/v1/signatures', 'reason' => 'no_permission'],
            ['channel' => 'mcp', 'action' => 'list_signatures', 'reason' => 'no_permission'],
        ], $refused);
        $this->client->request('GET', '/api/v1/app-activity?result=refused', server: $this->userHeaders('kim@example.test', ['settings:read']));
        /** @var array{items: list<array{reason: array{sentence: string}, permissions: list<array<string, mixed>>}>} $page */
        $page = $this->decodedResponse();
        self::assertSame('Some app does not have the permission See signatures. Nothing was read.', $page['items'][0]['reason']['sentence']);
        self::assertSame([['scope' => 'signatures:read', 'label' => 'See signatures', 'held' => false]], $page['items'][0]['permissions']);

        // Back on: the same token works again, without signing in again.
        $this->narrow($id, ['settings:read', 'signatures:read']);
        self::assertResponseIsSuccessful();
        $this->client->request('GET', '/api/v1/signatures', server: $headers);
        self::assertResponseIsSuccessful();
        self::assertContains('list_signatures', $this->mcpToolNames($headers, $session));
    }

    public function testAWhatsAppScopeIsSwitchedOffAndOnLikeAnyOther(): void
    {
        $headers = $this->thirdPartyHeaders('kim@example.test', ['settings:read', 'chat:read']);
        $session = $this->mcpInitialize($headers);
        self::assertContains('list_whatsapp_chats', $this->mcpToolNames($headers, $session));
        $id = $this->connectedAppId();

        $this->narrow($id, ['settings:read']);
        self::assertResponseIsSuccessful();
        self::assertNotContains('list_whatsapp_chats', $this->mcpToolNames($headers, $session));
        $this->client->request('GET', '/api/v1/chats', server: $headers);
        self::assertResponseStatusCodeSame(403);

        $this->narrow($id, ['settings:read', 'chat:read']);
        self::assertResponseIsSuccessful();
        self::assertContains('list_whatsapp_chats', $this->mcpToolNames($headers, $session));
    }

    public function testEverythingCanBeSwitchedOffWhileTheAppStaysConnected(): void
    {
        $headers = $this->thirdPartyHeaders('kim@example.test', ['settings:read']);
        $id = $this->connectedAppId();

        $this->narrow($id, []);
        self::assertResponseIsSuccessful();
        self::assertSame([], $this->decodedResponse()['scopes'] ?? null);
        $this->client->request('GET', '/api/v1/mail-accounts', server: $headers);
        self::assertResponseStatusCodeSame(403);
        self::assertSame(1, $this->countRows('SELECT COUNT(*) FROM oauth_consent'));
    }

    public function testOnlyWhatTheConsentScreenGrantedCanBeSwitchedOn(): void
    {
        $this->thirdPartyHeaders('kim@example.test', ['settings:read']);
        $id = $this->connectedAppId();

        foreach ([['settings:read', 'signatures:read'], ['settings:read', 'chat:read'], ['settings:read', 'sync:credentials'], ['settings:read', 'teams:read'], ['settings:read', 'settings:read']] as $scopes) {
            $this->narrow($id, $scopes);
            self::assertResponseStatusCodeSame(422, implode(' ', $scopes));
        }
        $this->client->request('PATCH', '/api/v1/connected-apps/'.$id, server: $this->userHeaders('kim@example.test', ['settings:write']) + ['CONTENT_TYPE' => 'application/merge-patch+json'], content: '{}');
        self::assertResponseStatusCodeSame(422, 'The scopes are required.');

        $this->narrow($id, ['settings:read', 'signatures:read']);
        self::assertStringContainsString('connect the app again and allow it there', (string) $this->client->getResponse()->getContent());
        self::assertSame(['settings:read'], $this->connectedApp()['scopes']);
    }

    public function testOnlyOurOwnAppsMayNarrowAndOnlyTheirOwnApps(): void
    {
        $this->thirdPartyHeaders('kim@example.test', ['settings:read', 'settings:write']);
        $id = $this->connectedAppId();
        $patch = ['CONTENT_TYPE' => 'application/merge-patch+json'];
        $body = (string) json_encode(['scopes' => ['settings:read', 'settings:write']]);

        $this->client->request('PATCH', '/api/v1/connected-apps/'.$id, server: $this->personalAccessTokenHeaders('kim@example.test', ['settings:read', 'settings:write']) + $patch, content: $body);
        self::assertResponseStatusCodeSame(403);
        $this->client->request('PATCH', '/api/v1/connected-apps/'.$id, server: $this->thirdPartyHeaders('kim@example.test', ['settings:read', 'settings:write']) + $patch, content: $body);
        self::assertResponseStatusCodeSame(403);
        $this->client->request('PATCH', '/api/v1/connected-apps/'.$id, server: $this->userHeaders('kim@example.test', ['settings:read']) + $patch, content: $body);
        self::assertResponseStatusCodeSame(403, 'settings:write is needed.');
        $this->client->request('PATCH', '/api/v1/connected-apps/'.$id, server: $this->userHeaders('lisa@example.test', ['settings:write']) + $patch, content: $body);
        self::assertResponseStatusCodeSame(404, 'Another user\'s app does not exist for Lisa.');
        $this->client->request('PATCH', '/api/v1/connected-apps/'.Uuid::v7()->toRfc4122(), server: $this->userHeaders('kim@example.test', ['settings:write']) + $patch, content: $body);
        self::assertResponseStatusCodeSame(404);
    }

    /**
     * @param list<string> $scopes
     */
    private function narrow(string $id, array $scopes): void
    {
        $this->client->request('PATCH', '/api/v1/connected-apps/'.$id, server: $this->userHeaders('kim@example.test', ['settings:write']) + ['CONTENT_TYPE' => 'application/merge-patch+json'], content: (string) json_encode(['scopes' => $scopes]));
    }

    private function connectedAppId(): string
    {
        $id = $this->connectedApp()['id'];
        self::assertIsString($id);

        return $id;
    }

    /**
     * Kim's one connected app, as the list has it.
     *
     * @return array<string, mixed>
     */
    private function connectedApp(): array
    {
        $this->client->request('GET', '/api/v1/connected-apps', server: $this->userHeaders('kim@example.test', ['settings:read']));
        self::assertResponseIsSuccessful();
        $apps = $this->decodedResponse();
        self::assertCount(1, $apps);
        $app = $apps[0];
        self::assertIsArray($app);

        /** @var array<string, mixed> */
        return $app;
    }
}
