<?php

declare(strict_types=1);

namespace App\Mcp\Tools;

use App\Account\Import\ImportPages;
use App\Enum\MailAccountStatus;
use App\Mcp\Api;
use App\Mcp\Tool\Schema;
use App\Mcp\Tool\Tool;
use App\Mcp\Tool\ToolArguments;
use App\Mcp\Tool\ToolEffect;
use App\Mcp\Tool\ToolProvider;
use App\Security\Scope;
use Symfony\Component\Uid\Uuid;

/**
 * The user's mail accounts: read them, rename them, pause and resume syncing, and find the page where the user signs an
 * account in again. Adding (see {@see MailAccountImportTools}) and removing an account and changing how it connects
 * (servers, username, password, calendar server) stay in Tresso's own apps, and the connection details are left out of
 * what these tools answer.
 */
final readonly class MailAccountTools implements ToolProvider
{
    private const string ACCOUNT_ID = 'The id of the mail account, from list_mail_accounts or get_me.';

    public function __construct(private ImportPages $pages)
    {
    }

    public function tools(): iterable
    {
        yield new Tool(
            name: 'list_mail_accounts',
            title: 'List mail accounts',
            description: 'The user\'s mail accounts: id, address, display name, provider, sync status (active, paused, '
                .'auth_failed or error, with a detail), calendar status, last sync and the id of the default signature.',
            scopes: [Scope::SettingsRead],
            effect: ToolEffect::Read,
            inputSchema: Schema::object(),
            run: static fn (ToolArguments $arguments, Api $api): array => array_map(self::summary(...), $api->get('/mail-accounts')),
        );

        yield new Tool(
            name: 'get_mail_account',
            title: 'Get a mail account',
            description: 'One mail account, as list_mail_accounts describes it.',
            scopes: [Scope::SettingsRead],
            effect: ToolEffect::Read,
            inputSchema: Schema::object(['id' => Schema::id(self::ACCOUNT_ID)], ['id']),
            run: static fn (ToolArguments $arguments, Api $api): array => self::summary($api->get('/mail-accounts/'.$arguments->id('id'))),
        );

        yield new Tool(
            name: 'update_mail_account',
            title: 'Rename, pause or resume a mail account',
            description: 'Changes the display name of a mail account (the name people see on mail sent from it) and/or '
                .'pauses or resumes syncing it. Only the fields given change. The default signature is set with '
                .'set_default_signature.',
            scopes: [Scope::SettingsWrite],
            effect: ToolEffect::Update,
            inputSchema: Schema::object([
                'id' => Schema::id(self::ACCOUNT_ID),
                'displayName' => Schema::string('The name shown as the sender of mail from this account.', 1, 120),
                'status' => Schema::enum(
                    [MailAccountStatus::Active->value, MailAccountStatus::Paused->value],
                    '"paused" stops syncing this account; "active" resumes it.',
                ),
            ], ['id']),
            run: static fn (ToolArguments $arguments, Api $api): array => self::summary(
                $api->patch('/mail-accounts/'.$arguments->id('id'), $arguments->only(['displayName', 'status'])),
            ),
        );

        yield new Tool(
            name: 'reconnect_mail_account',
            title: 'Where to sign a mail account in again',
            description: 'For a mail account whose sign-in failed (status auth_failed): answers the link to the page in '
                .'Tresso where the user signs it in again. Changes nothing. You cannot sign in for the user: give them '
                .'the link. Never ask the user for a password, an app password or a verification code.',
            scopes: [Scope::SettingsRead],
            effect: ToolEffect::Read,
            inputSchema: Schema::object(['id' => Schema::id(self::ACCOUNT_ID)], ['id']),
            run: $this->reconnect(...),
        );
    }

    /**
     * @return array<mixed>
     */
    private function reconnect(ToolArguments $arguments, Api $api): array
    {
        $account = self::summary($api->get('/mail-accounts/'.$arguments->id('id')));
        $id = $account['id'] ?? null;
        if (!\is_string($id)) {
            throw new \UnexpectedValueException('The API answered a mail account without an id.');
        }
        if (MailAccountStatus::AuthFailed->value !== ($account['status'] ?? null)) {
            return [
                'mailAccountId' => $id,
                'emailAddress' => $account['emailAddress'] ?? null,
                'status' => $account['status'] ?? null,
                'signInNeeded' => false,
                'instruction' => 'This account\'s sign-in has not failed, so there is nothing to sign in again.',
            ];
        }
        $link = $this->pages->accountPage(Uuid::fromString($id));

        return [
            'mailAccountId' => $id,
            'emailAddress' => $account['emailAddress'] ?? null,
            'status' => $account['status'],
            'statusDetail' => $account['statusDetail'] ?? null,
            'signInNeeded' => true,
            'link' => $link,
            'instruction' => 'Give the user this link: '.$link.' That page opens this account and says how to fix it: '
                .'signing in at Google or Microsoft again in their own browser, or typing the new password into Tresso. '
                .'You cannot sign in for them. Never ask the user for a password, an app password or a verification code.',
        ];
    }

    /**
     * A mail account without how it connects (username, servers, calendar server).
     *
     * @return array<mixed>
     */
    public static function summary(mixed $account): array
    {
        if (!\is_array($account)) {
            throw new \UnexpectedValueException('The API answered a mail account that is not an object.');
        }

        return array_intersect_key($account, array_flip([
            'id',
            'emailAddress',
            'displayName',
            'provider',
            'status',
            'statusDetail',
            'calendarStatus',
            'calendarStatusDetail',
            'lastSyncedAt',
            'createdAt',
            'defaultSignatureId',
        ]));
    }
}
