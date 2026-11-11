<?php

declare(strict_types=1);

namespace App\Entity;

use App\Enum\CalendarSyncStatus;
use App\Enum\MailAccountStatus;
use App\Enum\MailProvider;
use App\Enum\OAuthProvider;
use App\Mail\ServerSettings;
use App\Repository\MailAccountRepository;
use Doctrine\DBAL\Types\Types;
use App\Sync\Change\TracksChanges;
use Doctrine\ORM\Mapping as ORM;
use Symfony\Bridge\Doctrine\Types\UuidType;
use Symfony\Component\Uid\Uuid;

#[ORM\Entity(repositoryClass: MailAccountRepository::class)]
#[ORM\UniqueConstraint(columns: ['owner_id', 'email_address'])]
#[ORM\Index(columns: ['status', 'lease_expires_at'])]
#[ORM\Index(columns: ['owner_id', 'change_seq'])]
class MailAccount implements TracksChanges
{
    #[ORM\Id]
    #[ORM\Column(type: UuidType::NAME)]
    private Uuid $id;

    #[ORM\Column(type: Types::BIGINT, options: ['default' => 0])]
    private int $changeSeq = 0;

    #[ORM\ManyToOne]
    #[ORM\JoinColumn(nullable: false, onDelete: 'CASCADE')]
    private User $owner;

    #[ORM\Column(length: 320)]
    private string $emailAddress;

    #[ORM\Column(length: 120)]
    private string $displayName;

    #[ORM\Column(length: 16, enumType: MailProvider::class)]
    private MailProvider $provider;

    /**
     * Server settings without secrets: {"imap": {...}, "smtp": {...}, "username": "...", "caldav": "https://..."|null}.
     *
     * @var array<string, mixed>
     */
    #[ORM\Column(type: Types::JSON)]
    private array $connection = [];

    /**
     * The password of an IMAP account, encrypted with the owner's data key. Accounts connected through OAuth have none:
     * their tokens live on the provider grant.
     */
    #[ORM\Column(type: Types::TEXT, nullable: true)]
    private ?string $encryptedCredentials = null;

    /** The provider sign-in a Gmail or Microsoft 365 account syncs with; null for IMAP accounts. */
    #[ORM\ManyToOne]
    #[ORM\JoinColumn(nullable: true)]
    private ?ProviderGrant $providerGrant = null;

    #[ORM\Column(length: 16, enumType: MailAccountStatus::class)]
    private MailAccountStatus $status = MailAccountStatus::Active;

    /** Why the account is not syncing, in words the user can act on. */
    #[ORM\Column(length: 500, nullable: true)]
    private ?string $statusDetail = null;

    #[ORM\Column(length: 16, enumType: CalendarSyncStatus::class, options: ['default' => 'unknown'])]
    private CalendarSyncStatus $calendarStatus = CalendarSyncStatus::Unknown;

    /** Why the calendars do not sync, in words the user can act on. */
    #[ORM\Column(length: 500, nullable: true)]
    private ?string $calendarStatusDetail = null;

    /** The CalDAV address the worker found for status `unconfirmed`, for the user to confirm as calendar server. */
    #[ORM\Column(length: 2048, nullable: true)]
    private ?string $calendarFoundUrl = null;

    #[ORM\Column(length: 120, nullable: true)]
    private ?string $leasedBy = null;

    #[ORM\Column(nullable: true)]
    private ?\DateTimeImmutable $leaseExpiresAt = null;

    #[ORM\Column(nullable: true)]
    private ?\DateTimeImmutable $lastSyncedAt = null;

    /** Inserted into new messages from this account. Always one of the owner's own signatures. */
    #[ORM\ManyToOne]
    #[ORM\JoinColumn(onDelete: 'SET NULL')]
    private ?Signature $defaultSignature = null;

    #[ORM\Column]
    private \DateTimeImmutable $createdAt;

    public function __construct(User $owner, string $emailAddress, string $displayName, MailProvider $provider)
    {
        $this->id = Uuid::v7();
        $this->owner = $owner;
        $this->emailAddress = mb_strtolower($emailAddress);
        $this->displayName = $displayName;
        $this->provider = $provider;
        $this->createdAt = new \DateTimeImmutable();
    }

    public function getId(): Uuid
    {
        return $this->id;
    }

    public function getOwner(): User
    {
        return $this->owner;
    }

    public function getEmailAddress(): string
    {
        return $this->emailAddress;
    }

    public function getDisplayName(): string
    {
        return $this->displayName;
    }

    public function getProvider(): MailProvider
    {
        return $this->provider;
    }

    public function setDisplayName(string $displayName): void
    {
        $this->displayName = $displayName;
    }

    public function configureServers(ServerSettings $imap, ServerSettings $smtp, string $username): void
    {
        $this->connection = ['imap' => $imap->toArray(), 'smtp' => $smtp->toArray(), 'username' => $username, 'caldav' => $this->getCalendarServer()];
    }

    /** The CalDAV URL of the account's calendars: set by the user, or found by the worker. Null to discover it. */
    public function getCalendarServer(): ?string
    {
        $url = $this->connection['caldav'] ?? null;

        return \is_string($url) ? $url : null;
    }

    public function setCalendarServer(?string $url): void
    {
        $this->connection = [...$this->connection, 'caldav' => $url];
    }

    /** IMAP and SMTP settings exist only for IMAP accounts; Gmail and Microsoft 365 sync through their APIs. */
    public function usesServers(): bool
    {
        return MailProvider::Imap === $this->provider;
    }

    public function getImap(): ?ServerSettings
    {
        $value = $this->connection['imap'] ?? null;

        return \is_array($value) ? ServerSettings::fromArray($value) : null;
    }

    public function getSmtp(): ?ServerSettings
    {
        $value = $this->connection['smtp'] ?? null;

        return \is_array($value) ? ServerSettings::fromArray($value) : null;
    }

    public function getUsername(): ?string
    {
        $username = $this->connection['username'] ?? null;

        return \is_string($username) ? $username : null;
    }

    /**
     * Connection settings as the sync workers receive them; null when the account has no servers.
     *
     * @return array<string, mixed>|null
     */
    public function getConnection(): ?array
    {
        return [] === $this->connection ? null : $this->connection;
    }

    public function getProviderGrant(): ?ProviderGrant
    {
        return $this->providerGrant;
    }

    public function linkProviderGrant(ProviderGrant $grant): void
    {
        if (OAuthProvider::forMailProvider($this->provider) !== $grant->getProvider() || $grant->getOwner() !== $this->owner) {
            throw new \LogicException('A mail account can only use a grant of its own owner and provider.');
        }
        $this->providerGrant = $grant;
    }

    public function getEncryptedCredentials(): ?string
    {
        return $this->encryptedCredentials;
    }

    public function setEncryptedCredentials(?string $encryptedCredentials): void
    {
        $this->encryptedCredentials = $encryptedCredentials;
    }

    public function getStatus(): MailAccountStatus
    {
        return $this->status;
    }

    public function setStatus(MailAccountStatus $status, ?string $detail = null): void
    {
        $this->status = $status;
        $this->statusDetail = MailAccountStatus::Active === $status || MailAccountStatus::Paused === $status ? null : $detail;
        if (MailAccountStatus::Paused === $status) {
            // No worker holds a paused account: the one that did gets 404 on its next call, not after its heartbeat.
            $this->leasedBy = null;
            $this->leaseExpiresAt = null;
        }
    }

    public function getStatusDetail(): ?string
    {
        return $this->statusDetail;
    }

    public function getCalendarStatus(): CalendarSyncStatus
    {
        return $this->calendarStatus;
    }

    public function getCalendarStatusDetail(): ?string
    {
        return $this->calendarStatusDetail;
    }

    public function setCalendarStatus(CalendarSyncStatus $status, ?string $detail = null, ?string $foundUrl = null): void
    {
        $this->calendarStatus = $status;
        $this->calendarStatusDetail = CalendarSyncStatus::Active === $status ? null : $detail;
        $this->calendarFoundUrl = CalendarSyncStatus::Unconfirmed === $status ? $foundUrl : null;
    }

    public function getCalendarFoundUrl(): ?string
    {
        return $this->calendarFoundUrl;
    }

    public function getLeasedBy(): ?string
    {
        return $this->leasedBy;
    }

    public function getLeaseExpiresAt(): ?\DateTimeImmutable
    {
        return $this->leaseExpiresAt;
    }

    /**
     * Takes the account from the worker that holds it and keeps it from every worker until $until, so the holder's
     * next heartbeat no longer returns it: that worker stops its syncer (and its calls for the account answer 404 at
     * once). After $until the account is claimable again and a fresh syncer starts, with new credentials or servers
     * and its failure count and backoff from zero. Without the hold the holder would claim the free account again in
     * the same heartbeat and keep its old run. An account no worker holds (a refused login is not leased) has no old
     * run: it stays free, so the next heartbeat claims it.
     */
    public function restartSync(\DateTimeImmutable $until): void
    {
        if (null === $this->leasedBy) {
            return;
        }
        $this->leasedBy = null;
        $this->leaseExpiresAt = $until;
    }

    public function getLastSyncedAt(): ?\DateTimeImmutable
    {
        return $this->lastSyncedAt;
    }

    public function markSynced(\DateTimeImmutable $at): void
    {
        $this->lastSyncedAt = $at;
    }

    public function getDefaultSignature(): ?Signature
    {
        return $this->defaultSignature;
    }

    public function setDefaultSignature(?Signature $signature): void
    {
        if (null !== $signature && $signature->getOwner() !== $this->owner) {
            throw new \InvalidArgumentException('A mail account can only use a signature of its own owner.');
        }

        $this->defaultSignature = $signature;
    }

    public function getCreatedAt(): \DateTimeImmutable
    {
        return $this->createdAt;
    }

    public function getChangeOwner(): User
    {
        return $this->owner;
    }

    public static function clientFields(): ?array
    {
        return ['emailAddress', 'displayName', 'provider', 'status', 'statusDetail', 'lastSyncedAt', 'defaultSignature', 'calendarStatus', 'calendarStatusDetail'];
    }

    public static function changeType(): string
    {
        return 'mailAccount';
    }

    public function getChangeSeq(): int
    {
        return $this->changeSeq;
    }

    public function setChangeSeq(int $changeSeq): void
    {
        $this->changeSeq = $changeSeq;
    }
}
