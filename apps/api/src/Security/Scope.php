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
    case ChatRead = 'chat:read';
    case ChatSend = 'chat:send';
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
    public const string ROLE_CHAT_READ = 'ROLE_OAUTH2_CHAT:READ';
    public const string ROLE_CHAT_SEND = 'ROLE_OAUTH2_CHAT:SEND';
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
     * What a personal access token may hold: the user scopes, without those reserved for features not built yet and
     * without the chat scopes. Never a sync scope.
     *
     * @return list<self>
     */
    public static function personalAccessTokenScopes(): array
    {
        return array_values(array_filter(
            self::userScopes(),
            static fn (self $scope): bool => !\in_array($scope, [self::TeamsRead, self::TeamsWrite, self::WebhooksManage, ...self::chatScopes()], true),
        ));
    }

    /**
     * WhatsApp chats are private: only these scopes reach them for a caller that is not one of our own apps, and no
     * other scope implies them, so no grant from before gains them. An app that is not ours may ask for them by name
     * ({@see \App\Security\OAuth\ThirdPartyClients::mayAskFor()}), the user then sees them on the consent screen;
     * they are not advertised in the metadata, nor offered for personal access tokens, until the MCP tools for chats
     * exist.
     *
     * @return list<self>
     */
    public static function chatScopes(): array
    {
        return [self::ChatRead, self::ChatSend];
    }

    /**
     * What an app that is not ours (registered through dynamic client registration, such as an MCP client) is offered
     * and may ask for without naming a scope: the same as a personal access token. Never a sync scope, and never the
     * scopes of features not built yet. It may also ask for the {@see chatScopes()} by name.
     *
     * @return list<self>
     */
    public static function thirdPartyAppScopes(): array
    {
        return self::personalAccessTokenScopes();
    }

    /**
     * The scope in a few words, as the consent screen lists it. Matches PERSONAL_ACCESS_TOKEN_SCOPES in packages/core.
     */
    public function label(): string
    {
        return match ($this) {
            self::MailRead => 'Read mail',
            self::MailWrite => 'Organize mail',
            self::MailSend => 'Send mail',
            self::TodosRead => 'See todos',
            self::TodosWrite => 'Change todos',
            self::CalendarRead => 'See calendar',
            self::CalendarWrite => 'Change calendar',
            self::SettingsRead => 'See settings',
            self::SettingsWrite => 'Change settings',
            self::SignaturesRead => 'See signatures',
            self::SignaturesWrite => 'Change signatures',
            self::TeamsRead => 'See teams',
            self::TeamsWrite => 'Change teams',
            self::WebhooksManage => 'Manage webhooks',
            self::ChatRead => 'Read your WhatsApp chats',
            self::ChatSend => 'Send WhatsApp messages as you',
            self::SyncLease, self::SyncIngest, self::SyncCredentials => 'Sync mail for the server',
        };
    }

    /** What an app holding this scope can do, in plain words, for the consent screen. */
    public function description(): string
    {
        return match ($this) {
            self::MailRead => 'Read your messages, conversations, attachments and drafts in every account.',
            self::MailWrite => 'Archive, move, flag, mark as read and delete messages.',
            self::MailSend => 'Send messages from your accounts, in your name.',
            self::TodosRead => 'See your todos and when they are planned.',
            self::TodosWrite => 'Add, complete, change and delete todos.',
            self::CalendarRead => 'See your calendars and events, with their guests, your notes and reminders.',
            self::CalendarWrite => 'Add, change and delete events and set your answers. Telling guests or organizers also needs Send mail.',
            self::SettingsRead => 'See your mail accounts, smart inboxes and other settings.',
            self::SettingsWrite => 'Change settings such as account names, smart inboxes, rules and notifications. Never how a mail account connects, access tokens or connected apps.',
            self::SignaturesRead => 'See your email signatures.',
            self::SignaturesWrite => 'Add, change and delete email signatures.',
            self::TeamsRead => 'See your teams.',
            self::TeamsWrite => 'Change your teams.',
            self::WebhooksManage => 'Add, change and delete webhooks.',
            self::ChatRead => 'Read the WhatsApp chats and messages your Mac passes on to Tresso, and the replies waiting to go out.',
            self::ChatSend => 'Write replies in your WhatsApp chats; your Mac sends them from your WhatsApp.',
            self::SyncLease, self::SyncIngest, self::SyncCredentials => 'Fetch and store mail as the server does.',
        };
    }

    /** @return list<self> */
    public static function syncScopes(): array
    {
        return [self::SyncLease, self::SyncIngest, self::SyncCredentials];
    }
}
