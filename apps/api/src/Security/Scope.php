<?php

declare(strict_types=1);

namespace App\Security;

/**
 * OAuth2 scopes. Keep in sync with config/packages/league_oauth2_server.yaml.
 */
enum Scope: string
{
    case MailRead = 'mail:read';
    case MailWrite = 'mail:write';
    case MailSend = 'mail:send';
    case TodosRead = 'todos:read';
    case TodosWrite = 'todos:write';
    case CalendarRead = 'calendar:read';
    case CalendarWrite = 'calendar:write';
    case SettingsRead = 'settings:read';
    case SettingsWrite = 'settings:write';
    case SignaturesRead = 'signatures:read';
    case SignaturesWrite = 'signatures:write';
    case TeamsRead = 'teams:read';
    case TeamsWrite = 'teams:write';
    case WebhooksManage = 'webhooks:manage';
    case SyncLease = 'sync:lease';
    case SyncIngest = 'sync:ingest';
    case SyncCredentials = 'sync:credentials';

    /** Role granted by the OAuth2 authenticator for this scope (see `role_prefix`). */
    public const string ROLE_PREFIX = 'ROLE_OAUTH2_';

    public const string ROLE_MAIL_READ = 'ROLE_OAUTH2_MAIL:READ';
    public const string ROLE_MAIL_WRITE = 'ROLE_OAUTH2_MAIL:WRITE';
    public const string ROLE_MAIL_SEND = 'ROLE_OAUTH2_MAIL:SEND';
    public const string ROLE_CALENDAR_READ = 'ROLE_OAUTH2_CALENDAR:READ';
    public const string ROLE_CALENDAR_WRITE = 'ROLE_OAUTH2_CALENDAR:WRITE';
    public const string ROLE_TODOS_READ = 'ROLE_OAUTH2_TODOS:READ';
    public const string ROLE_TODOS_WRITE = 'ROLE_OAUTH2_TODOS:WRITE';
    public const string ROLE_SETTINGS_READ = 'ROLE_OAUTH2_SETTINGS:READ';
    public const string ROLE_SETTINGS_WRITE = 'ROLE_OAUTH2_SETTINGS:WRITE';
    public const string ROLE_SIGNATURES_READ = 'ROLE_OAUTH2_SIGNATURES:READ';
    public const string ROLE_SIGNATURES_WRITE = 'ROLE_OAUTH2_SIGNATURES:WRITE';
    public const string ROLE_SYNC_LEASE = 'ROLE_OAUTH2_SYNC:LEASE';
    public const string ROLE_SYNC_INGEST = 'ROLE_OAUTH2_SYNC:INGEST';
    public const string ROLE_SYNC_CREDENTIALS = 'ROLE_OAUTH2_SYNC:CREDENTIALS';

    public function role(): string
    {
        return self::ROLE_PREFIX.strtoupper($this->value);
    }

    /** @return list<self> */
    public static function userScopes(): array
    {
        return array_values(array_filter(self::cases(), static fn (self $scope): bool => !str_starts_with($scope->value, 'sync:')));
    }

    /**
     * What a personal access token may hold: the user scopes, without those reserved for features not built yet. Never
     * a sync scope.
     *
     * @return list<self>
     */
    public static function personalAccessTokenScopes(): array
    {
        return array_values(array_filter(
            self::userScopes(),
            static fn (self $scope): bool => !\in_array($scope, [self::TeamsRead, self::TeamsWrite, self::WebhooksManage], true),
        ));
    }

    /** @return list<self> */
    public static function syncScopes(): array
    {
        return [self::SyncLease, self::SyncIngest, self::SyncCredentials];
    }
}
