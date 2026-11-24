<?php

declare(strict_types=1);

namespace App\ApiResource;

use ApiPlatform\Metadata\ApiProperty;
use ApiPlatform\Metadata\ApiResource;
use ApiPlatform\Metadata\Delete;
use ApiPlatform\Metadata\Get;
use ApiPlatform\Metadata\GetCollection;
use ApiPlatform\Metadata\Post;
use App\ApiResource\Input\MailAccountImport\CreateMailAccountImport;
use App\ApiResource\Input\MailAccountImport\UpdateImportEntry;
use App\Security\FirstPartyClients;
use App\Security\Scope;
use App\State\MailAccountImportProcessor;
use App\State\MailAccountImportProvider;

/**
 * A list of mail addresses the user wants to add (an "import list"), made in Tresso's apps or by an assistant through
 * MCP. Making one connects nothing: the user connects each address on the web app's page for the list (`pageUrl`),
 * signing in at Google or Microsoft or typing the password into Tresso. A list belongs to the user who made it, holds
 * at most 50 addresses and lives 24 hours; afterwards it is gone (404), like another user's list.
 *
 * Each entry says where it stands: `todo`, `connected` (added from this list), `already_connected` (the user has a mail
 * account with the address that was added another way), `failed` (with `failure`, a code, `reason`, a sentence, and
 * for `admin_approval_required` the `approvalUrl` for the organization's administrator) or `skipped`. On creation `leftOut` names
 * the addresses that were not taken and why (`invalid`, `duplicate`, `already_connected`); it is empty on later reads.
 * `createdBy` names the app that made the list when it is not one of Tresso's own, so the page can say so; such a list
 * is `confirmed` only once the user checked its addresses and chose to use them, and the page looks nothing up and
 * offers no sign-in before. An app or a token sees, follows and deletes only the lists it made itself; marking entries
 * and confirming are for Tresso's own apps.
 */
#[ApiResource(
    shortName: 'MailAccountImport',
    routePrefix: '/api/v1',
    normalizationContext: ['skip_null_values' => false],
    operations: [
        new GetCollection(
            uriTemplate: '/mail-account-imports',
            paginationEnabled: false,
            security: "is_granted('".Scope::ROLE_SETTINGS_READ."')",
            provider: MailAccountImportProvider::class,
        ),
        new Get(
            uriTemplate: '/mail-account-imports/{id}',
            security: "is_granted('".Scope::ROLE_SETTINGS_READ."')",
            provider: MailAccountImportProvider::class,
        ),
        new Post(
            uriTemplate: '/mail-account-imports',
            security: "is_granted('".Scope::ROLE_SETTINGS_WRITE."')",
            input: CreateMailAccountImport::class,
            denormalizationContext: ['allow_extra_attributes' => false],
            read: false,
            processor: MailAccountImportProcessor::class,
        ),
        // Skips an entry, sets it back to do, or records how the server form went: Tresso's own apps only.
        new Post(
            uriTemplate: '/mail-account-imports/{id}/entry-states',
            status: 200,
            security: "is_granted('".Scope::ROLE_SETTINGS_WRITE."') and is_granted('".FirstPartyClients::ATTRIBUTE."')",
            input: UpdateImportEntry::class,
            denormalizationContext: ['allow_extra_attributes' => false],
            provider: MailAccountImportProvider::class,
            processor: MailAccountImportProcessor::class,
            name: 'mail_account_import_entry_state',
        ),
        // The user checked the addresses of a list an app made and uses them: Tresso's own apps only.
        new Post(
            uriTemplate: '/mail-account-imports/{id}/confirmation',
            status: 200,
            security: "is_granted('".Scope::ROLE_SETTINGS_WRITE."') and is_granted('".FirstPartyClients::ATTRIBUTE."')",
            input: false,
            deserialize: false,
            provider: MailAccountImportProvider::class,
            processor: MailAccountImportProcessor::class,
            name: 'mail_account_import_confirmation',
        ),
        // An app or a token deletes only a list it made (another one is not found for it).
        new Delete(
            uriTemplate: '/mail-account-imports/{id}',
            security: "is_granted('".Scope::ROLE_SETTINGS_WRITE."')",
            provider: MailAccountImportProvider::class,
            processor: MailAccountImportProcessor::class,
        ),
    ],
)]
final readonly class MailAccountImportResource
{
    /**
     * @param list<array{id: string, address: string, provider: ?string, state: string, failure: ?string, reason: ?string, mailAccountId: ?string, accountStatus: ?string, approvalUrl: ?string}> $entries
     * @param list<array{address: string, reason: string, message: string}>                                                                                          $leftOut
     * @param array{todo: int, connected: int, already_connected: int, failed: int, skipped: int}                                                                                           $progress
     */
    public function __construct(
        #[ApiProperty(identifier: true)]
        public string $id,
        public array $entries,
        public array $progress,
        public ?string $createdBy,
        /** Whether `createdBy` is a personal access token rather than an app ("made with" rather than "made by"). */
        public bool $createdWithToken,
        public bool $confirmed,
        /** The web app's page for this list, where the user connects the addresses. */
        public string $pageUrl,
        public \DateTimeImmutable $createdAt,
        public \DateTimeImmutable $expiresAt,
        public array $leftOut = [],
    ) {
    }
}
