<?php

declare(strict_types=1);

namespace App\Tests\Unit;

use App\Security\OAuth\ThirdPartyClients;
use App\Security\Scope;
use PHPUnit\Framework\TestCase;
use Symfony\Component\Yaml\Yaml;

final class ScopeTest extends TestCase
{
    public function testEnumMatchesConfiguredScopes(): void
    {
        /** @var array{league_oauth2_server: array{scopes: array{available: list<string>}}} $config */
        $config = Yaml::parseFile(\dirname(__DIR__, 2).'/config/packages/league_oauth2_server.yaml');

        self::assertSame(
            $config['league_oauth2_server']['scopes']['available'],
            array_map(static fn (Scope $scope): string => $scope->value, Scope::cases()),
        );
    }

    public function testRoleConstantsMatchScopes(): void
    {
        self::assertSame(Scope::MailRead->role(), Scope::ROLE_MAIL_READ);
        self::assertSame(Scope::MailWrite->role(), Scope::ROLE_MAIL_WRITE);
        self::assertSame(Scope::MailSend->role(), Scope::ROLE_MAIL_SEND);
        self::assertSame(Scope::CalendarRead->role(), Scope::ROLE_CALENDAR_READ);
        self::assertSame(Scope::CalendarWrite->role(), Scope::ROLE_CALENDAR_WRITE);
        self::assertSame(Scope::TodosRead->role(), Scope::ROLE_TODOS_READ);
        self::assertSame(Scope::TodosWrite->role(), Scope::ROLE_TODOS_WRITE);
        self::assertSame(Scope::SettingsRead->role(), Scope::ROLE_SETTINGS_READ);
        self::assertSame(Scope::SettingsWrite->role(), Scope::ROLE_SETTINGS_WRITE);
        self::assertSame(Scope::SignaturesRead->role(), Scope::ROLE_SIGNATURES_READ);
        self::assertSame(Scope::SignaturesWrite->role(), Scope::ROLE_SIGNATURES_WRITE);
        self::assertSame(Scope::ChatRead->role(), Scope::ROLE_CHAT_READ);
        self::assertSame(Scope::ChatSend->role(), Scope::ROLE_CHAT_SEND);
        self::assertSame(Scope::SyncLease->role(), Scope::ROLE_SYNC_LEASE);
        self::assertSame(Scope::SyncIngest->role(), Scope::ROLE_SYNC_INGEST);
        self::assertSame(Scope::SyncCredentials->role(), Scope::ROLE_SYNC_CREDENTIALS);
    }

    public function testUserAndSyncScopesDoNotOverlap(): void
    {
        self::assertSame([], array_intersect(
            array_map(static fn (Scope $s): string => $s->value, Scope::userScopes()),
            array_map(static fn (Scope $s): string => $s->value, Scope::syncScopes()),
        ));
        self::assertCount(\count(Scope::cases()), [...Scope::userScopes(), ...Scope::syncScopes()]);
    }

    public function testPersonalAccessTokensGetNoSyncOrReservedScopes(): void
    {
        $scopes = array_map(static fn (Scope $s): string => $s->value, Scope::personalAccessTokenScopes());

        self::assertSame([], array_values(array_filter($scopes, static fn (string $scope): bool => str_starts_with($scope, 'sync:'))));
        self::assertNotContains('teams:read', $scopes);
        self::assertNotContains('teams:write', $scopes);
        self::assertNotContains('webhooks:manage', $scopes);
        self::assertContains('mail:read', $scopes);
        self::assertContains('settings:write', $scopes);
    }

    /**
     * Chats are reached only by their own scopes: no other scope grants them, they are not offered for personal access
     * tokens nor advertised to apps that are not ours, which may only ask for them by name.
     */
    public function testChatScopesAreOnlyAskedForByName(): void
    {
        $offered = array_map(static fn (Scope $s): string => $s->value, [...Scope::personalAccessTokenScopes(), ...Scope::thirdPartyAppScopes()]);

        self::assertSame([Scope::ChatRead, Scope::ChatSend], Scope::chatScopes());
        self::assertNotContains('chat:read', $offered);
        self::assertNotContains('chat:send', $offered);
        self::assertTrue(ThirdPartyClients::mayAskFor('chat:read'));
        self::assertTrue(ThirdPartyClients::mayAskFor('chat:send'));
        self::assertFalse(ThirdPartyClients::mayAskFor('sync:ingest'));
        self::assertFalse(ThirdPartyClients::mayAskFor('teams:read'));
        self::assertSame('Read your WhatsApp chats', Scope::ChatRead->label());
        self::assertSame('Send WhatsApp messages as you', Scope::ChatSend->label());
    }
}
