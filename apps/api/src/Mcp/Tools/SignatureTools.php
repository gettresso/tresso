<?php

declare(strict_types=1);

namespace App\Mcp\Tools;

use App\Mcp\Api;
use App\Mcp\Tool\Schema;
use App\Mcp\Tool\Tool;
use App\Mcp\Tool\ToolArguments;
use App\Mcp\Tool\ToolEffect;
use App\Mcp\Tool\ToolProvider;
use App\Security\Scope;
use App\Mail\Body\SignatureHtmlSanitizer;

/**
 * Email signatures (/api/v1/signatures) and which one each mail account inserts by default. The default is part of
 * the signature (`defaultFor`, the accounts that use it); set_default_signature changes it from the account's side.
 */
final readonly class SignatureTools implements ToolProvider
{
    private const string SIGNATURE_ID = 'The id of the signature, from list_signatures.';

    public function tools(): iterable
    {
        yield new Tool(
            name: 'list_signatures',
            title: 'List signatures',
            description: 'The user\'s email signatures, sorted by name: id, name, HTML, the ids of the mail accounts '
                .'that insert it by default (defaultFor) and when it last changed.',
            scopes: [Scope::SignaturesRead],
            effect: ToolEffect::Read,
            inputSchema: Schema::object(),
            run: static fn (ToolArguments $arguments, Api $api): array => $api->get('/signatures'),
        );

        yield new Tool(
            name: 'get_signature',
            title: 'Get a signature',
            description: 'One email signature, as list_signatures describes it.',
            scopes: [Scope::SignaturesRead],
            effect: ToolEffect::Read,
            inputSchema: Schema::object(['id' => Schema::id(self::SIGNATURE_ID)], ['id']),
            run: static fn (ToolArguments $arguments, Api $api): array => $api->get('/signatures/'.$arguments->id('id')),
        );

        yield new Tool(
            name: 'create_signature',
            title: 'Create a signature',
            description: 'Adds an email signature. The HTML is cleaned before it is stored: ordinary markup, inline '
                .'styles and links stay; scripts, event handlers, forms, frames and style elements go, and images only '
                .'load from https, data or cid: URLs. Optionally make it the default of mail accounts right away.',
            scopes: [Scope::SignaturesWrite],
            effect: ToolEffect::Create,
            inputSchema: Schema::object([
                'name' => self::name(),
                'html' => self::html(),
                'defaultFor' => self::defaultFor('Mail accounts that insert this signature by default from now on, replacing the default they had.'),
            ], ['name']),
            run: static fn (ToolArguments $arguments, Api $api): array => $api->post('/signatures', $arguments->only(['name', 'html', 'defaultFor'])),
        );

        yield new Tool(
            name: 'update_signature',
            title: 'Change a signature',
            description: 'Changes the name, the HTML and/or the accounts that use a signature by default. Only the fields '
                .'given change. defaultFor is the complete new list: accounts left out that used this signature get no '
                .'default; to change one account, set_default_signature is simpler.',
            scopes: [Scope::SignaturesWrite],
            effect: ToolEffect::Update,
            inputSchema: Schema::object([
                'id' => Schema::id(self::SIGNATURE_ID),
                'name' => self::name(),
                'html' => self::html(),
                'defaultFor' => self::defaultFor('The complete list of mail accounts that insert this signature by default.'),
            ], ['id']),
            run: static fn (ToolArguments $arguments, Api $api): array => $api->patch('/signatures/'.$arguments->id('id'), $arguments->only(['name', 'html', 'defaultFor'])),
        );

        yield new Tool(
            name: 'delete_signature',
            title: 'Delete a signature',
            description: 'Deletes an email signature for good. Mail accounts that used it by default get no default signature.',
            scopes: [Scope::SignaturesWrite],
            effect: ToolEffect::Delete,
            inputSchema: Schema::object(['id' => Schema::id(self::SIGNATURE_ID)], ['id']),
            run: static function (ToolArguments $arguments, Api $api): array {
                $id = $arguments->id('id');
                $api->delete('/signatures/'.$id);

                return ['deleted' => $id];
            },
        );

        yield new Tool(
            name: 'set_default_signature',
            title: 'Set the default signature of a mail account',
            description: 'Makes a signature the one a mail account inserts by default in new messages, or with '
                .'signatureId null leaves the account without a default signature. Other accounts keep theirs.',
            scopes: [Scope::SignaturesRead, Scope::SignaturesWrite, Scope::SettingsRead],
            effect: ToolEffect::Update,
            inputSchema: Schema::object([
                'mailAccountId' => Schema::id('The id of the mail account, from list_mail_accounts or get_me.'),
                'signatureId' => Schema::nullable(Schema::id('The id of the signature, from list_signatures; null for no default signature.')),
            ], ['mailAccountId', 'signatureId']),
            run: self::setDefault(...),
        );
    }

    /**
     * Adds the account to the signature's `defaultFor` (which takes it away from the signature it had), or removes it
     * from the signature that has it. Both through PATCH /signatures/{id}, the only place the API sets a default. The
     * account is read first (GET /mail-accounts/{id}), so an unknown account or another user's is "not found" either
     * way, and clearing finds the signature to change from the account itself.
     *
     * @return array<mixed>
     */
    private static function setDefault(ToolArguments $arguments, Api $api): array
    {
        $accountId = $arguments->id('mailAccountId');
        $account = $api->get('/mail-accounts/'.$accountId);
        $current = \is_string($account['defaultSignatureId'] ?? null) ? $account['defaultSignatureId'] : null;

        if (null !== $arguments->get('signatureId')) {
            $signatureId = $arguments->id('signatureId');
            $signature = $api->get('/signatures/'.$signatureId);
            $defaultFor = self::accountsOf($signature);
            if (!\in_array($accountId, $defaultFor, true)) {
                $signature = $api->patch('/signatures/'.$signatureId, ['defaultFor' => [...$defaultFor, $accountId]]);
            }

            return ['mailAccountId' => $accountId, 'defaultSignatureId' => $signatureId, 'changed' => $current !== $signatureId, 'signature' => $signature];
        }

        if (null === $current) {
            return ['mailAccountId' => $accountId, 'defaultSignatureId' => null, 'changed' => false];
        }

        $defaultFor = self::accountsOf($api->get('/signatures/'.$current));
        $api->patch('/signatures/'.$current, ['defaultFor' => array_values(array_diff($defaultFor, [$accountId]))]);

        return ['mailAccountId' => $accountId, 'defaultSignatureId' => null, 'changed' => true];
    }

    /**
     * @return list<string>
     */
    private static function accountsOf(mixed $signature): array
    {
        $defaultFor = \is_array($signature) ? ($signature['defaultFor'] ?? null) : null;

        return \is_array($defaultFor) ? array_values(array_filter($defaultFor, \is_string(...))) : [];
    }

    /**
     * @return array<string, mixed>
     */
    private static function name(): array
    {
        return Schema::string('A short name the user recognizes, such as "Work" or "Short reply".', 1, 120);
    }

    /**
     * @return array<string, mixed>
     */
    private static function html(): array
    {
        return Schema::string(\sprintf('The signature as HTML, at most %d bytes.', SignatureHtmlSanitizer::MAX_INPUT_BYTES));
    }

    /**
     * @return array<string, mixed>
     */
    private static function defaultFor(string $description): array
    {
        return Schema::list(Schema::id('A mail account id, from list_mail_accounts or get_me.'), $description, unique: true);
    }
}
