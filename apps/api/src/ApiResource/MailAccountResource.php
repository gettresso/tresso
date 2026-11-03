<?php

declare(strict_types=1);

namespace App\ApiResource;

use ApiPlatform\Metadata\ApiProperty;
use ApiPlatform\Metadata\ApiResource;
use ApiPlatform\Metadata\Delete;
use ApiPlatform\Metadata\Get;
use ApiPlatform\Metadata\GetCollection;
use ApiPlatform\Metadata\Patch;
use ApiPlatform\Metadata\Post;
use App\ApiResource\Input\CreateMailAccount;
use App\ApiResource\Input\UpdateMailAccount;
use App\Entity\MailAccount;
use App\Enum\CalendarSyncStatus;
use App\Enum\MailAccountStatus;
use App\Enum\MailProvider;
use App\Mail\ServerSettings;
use App\Security\FirstPartyClients;
use App\Security\Scope;
use App\State\MailAccountProcessor;
use App\State\MailAccountProvider;

/**
 * A mail account of the signed-in user. Credentials can be written but are never returned.
 *
 * Gmail and Microsoft 365 accounts (provider "gmail", "microsoft") are created by signing in with the provider
 * (see {@see ProviderAuthorization}) and have no username or server settings: those fields are null.
 */
#[ApiResource(
    shortName: 'MailAccount',
    routePrefix: '/api/v1',
    // Clients tell "never synced" and "no problem" apart from missing data by explicit nulls.
    normalizationContext: ['skip_null_values' => false],
    operations: [
        new GetCollection(
            uriTemplate: '/mail-accounts',
            paginationEnabled: false,
            security: "is_granted('".Scope::ROLE_SETTINGS_READ."')",
            provider: MailAccountProvider::class,
        ),
        new Get(
            uriTemplate: '/mail-accounts/{id}',
            security: "is_granted('".Scope::ROLE_SETTINGS_READ."')",
            provider: MailAccountProvider::class,
        ),
        new Post(
            uriTemplate: '/mail-accounts',
            security: "is_granted('".Scope::ROLE_SETTINGS_WRITE."') and is_granted('".FirstPartyClients::ATTRIBUTE."')",
            input: CreateMailAccount::class,
            read: false,
            processor: MailAccountProcessor::class,
        ),
        new Patch(
            uriTemplate: '/mail-accounts/{id}',
            security: "is_granted('".Scope::ROLE_SETTINGS_WRITE."')",
            input: UpdateMailAccount::class,
            provider: MailAccountProvider::class,
            processor: MailAccountProcessor::class,
        ),
        new Delete(
            uriTemplate: '/mail-accounts/{id}',
            security: "is_granted('".Scope::ROLE_SETTINGS_WRITE."') and is_granted('".FirstPartyClients::ATTRIBUTE."')",
            provider: MailAccountProvider::class,
            processor: MailAccountProcessor::class,
        ),
    ],
)]
final class MailAccountResource
{
    public function __construct(
        #[ApiProperty(identifier: true)]
        public string $id,
        public string $emailAddress,
        public string $displayName,
        public MailProvider $provider,
        public MailAccountStatus $status,
        public ?string $statusDetail,
        public ?string $username,
        public ?ServerSettings $imap,
        public ?ServerSettings $smtp,
        public ?string $calendarUrl,
        public CalendarSyncStatus $calendarStatus,
        public ?string $calendarStatusDetail,
        public ?\DateTimeImmutable $lastSyncedAt,
        public \DateTimeImmutable $createdAt,
        /** Set through the signature's "defaultFor" (/api/v1/signatures). */
        public ?string $defaultSignatureId,
    ) {
    }

    public static function fromEntity(MailAccount $account): self
    {
        return new self(
            $account->getId()->toRfc4122(),
            $account->getEmailAddress(),
            $account->getDisplayName(),
            $account->getProvider(),
            $account->getStatus(),
            $account->getStatusDetail(),
            $account->getUsername(),
            $account->getImap(),
            $account->getSmtp(),
            $account->getCalendarServer(),
            $account->getCalendarStatus(),
            $account->getCalendarStatusDetail(),
            $account->getLastSyncedAt(),
            $account->getCreatedAt(),
            $account->getDefaultSignature()?->getId()->toRfc4122(),
        );
    }
}
