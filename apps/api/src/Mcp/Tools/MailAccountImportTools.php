<?php

declare(strict_types=1);

namespace App\Mcp\Tools;

use App\Entity\MailAccountImport;
use App\Enum\ImportProviderHint;
use App\Mcp\Api;
use App\Mcp\Tool\Schema;
use App\Mcp\Tool\Tool;
use App\Mcp\Tool\ToolArguments;
use App\Mcp\Tool\ToolEffect;
use App\Mcp\Tool\ToolProvider;
use App\Security\Scope;

/**
 * Adding mail accounts through an assistant, many at once: the assistant makes a list of addresses and hands the user
 * the link to Tresso's page for it, where the user signs in for each one. An assistant never signs in itself: signing in
 * at Google or Microsoft (with two-step verification and consent) happens in the user's browser, and a password for an
 * IMAP account is typed into Tresso only. No tool takes or answers a password, code or token.
 */
final readonly class MailAccountImportTools implements ToolProvider
{
    public const string NO_SIGN_IN = 'You cannot sign in to mail accounts yourself: the user signs in for each address on that '
        .'page, at Google or Microsoft in their own browser or by typing the password into Tresso. Never ask the user '
        .'for a password, an app password or a verification code, and never accept one if they offer it: tell them to '
        .'type it into Tresso.';

    public function tools(): iterable
    {
        yield new Tool(
            name: 'add_mail_accounts',
            title: 'Make a list of mail accounts to add',
            description: 'Makes a list of 1 to 50 mail addresses the user wants to add to Tresso, and answers the link to '
                .'Tresso\'s page for that list. This connects nothing and changes no account: the user opens the link and '
                .'signs in for each address there. You cannot sign in for the user. Never ask the user for passwords, app '
                .'passwords or verification codes. Addresses that are not valid, appear twice or are connected already '
                .'are left out and named in the answer with the reason. The list lasts 24 hours; follow it with '
                .'get_mail_account_import.',
            scopes: [Scope::SettingsWrite],
            effect: ToolEffect::Create,
            inputSchema: Schema::object([
                'entries' => Schema::list(
                    Schema::object([
                        'address' => Schema::string('The mail address to add.', 1, 320),
                        'provider' => Schema::enum(
                            array_map(static fn (ImportProviderHint $hint): string => $hint->value, ImportProviderHint::cases()),
                            'How the address connects, if known: google (Gmail, Google Workspace), microsoft (Outlook, '
                            .'Microsoft 365) or imap (any other provider). Only a hint: Tresso looks the address up '
                            .'itself and uses this when that finds nothing.',
                        ),
                    ], ['address']),
                    'The addresses to add.',
                    1,
                    MailAccountImport::MAX_ENTRIES,
                ),
            ], ['entries']),
            run: static function (ToolArguments $arguments, Api $api): array {
                $entries = $arguments->get('entries');
                $import = $api->post('/mail-account-imports', ['entries' => \is_array($entries) ? array_values($entries) : []]);
                $summary = self::summary($import);

                return [
                    'importId' => $summary['importId'],
                    'link' => $summary['link'],
                    'taken' => \count($summary['entries']),
                    'leftOut' => array_map(
                        static fn (mixed $left): array => \is_array($left) ? array_intersect_key($left, array_flip(['address', 'reason', 'message'])) : [],
                        \is_array($import['leftOut'] ?? null) ? $import['leftOut'] : [],
                    ),
                    'entries' => $summary['entries'],
                    'expiresAt' => $summary['expiresAt'],
                    'instruction' => 'Give the user this link: '.$summary['link'].' '.self::NO_SIGN_IN,
                ];
            },
        );

        yield new Tool(
            name: 'get_mail_account_import',
            title: 'Follow a list of mail accounts to add',
            description: 'Where each address of a list made with add_mail_accounts stands: todo, connected (added from the list), '
                .'already_connected (added another way), failed (with the reason) or skipped, with the counts and the link to the page where the user signs in. Use it to tell '
                .'the user how far they are. It cannot sign in or retry anything: only the user can, on that page.',
            scopes: [Scope::SettingsRead],
            effect: ToolEffect::Read,
            inputSchema: Schema::object(['id' => Schema::id('The importId add_mail_accounts answered.')], ['id']),
            run: static function (ToolArguments $arguments, Api $api): array {
                $summary = self::summary($api->get('/mail-account-imports/'.$arguments->id('id')));
                $summary['instruction'] = 'To connect what is left, the user opens '.$summary['link'].' '.self::NO_SIGN_IN;

                return $summary;
            },
        );
    }

    /**
     * An import list as a tool answers it: each address with where it stands, without the internals of the page.
     *
     * @return array{importId: string, link: string, createdBy: mixed, progress: mixed, entries: list<array<mixed>>, expiresAt: mixed}
     */
    private static function summary(mixed $import): array
    {
        if (!\is_array($import) || !\is_string($import['id'] ?? null) || !\is_string($import['pageUrl'] ?? null)) {
            throw new \UnexpectedValueException('The API answered an import list without an id or a page.');
        }
        $entries = [];
        foreach (\is_array($import['entries'] ?? null) ? $import['entries'] : [] as $entry) {
            if (\is_array($entry)) {
                $entries[] = array_intersect_key($entry, array_flip(['address', 'provider', 'state', 'reason', 'mailAccountId']));
            }
        }

        return [
            'importId' => $import['id'],
            'link' => $import['pageUrl'],
            'createdBy' => $import['createdBy'] ?? null,
            'progress' => $import['progress'] ?? null,
            'entries' => $entries,
            'expiresAt' => $import['expiresAt'] ?? null,
        ];
    }
}
