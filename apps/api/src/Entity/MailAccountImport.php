<?php

declare(strict_types=1);

namespace App\Entity;

use App\Repository\MailAccountImportRepository;
use Doctrine\DBAL\Types\Types;
use Doctrine\ORM\Mapping as ORM;
use Symfony\Bridge\Doctrine\Types\UuidType;
use Symfony\Component\Uid\Uuid;

/**
 * A short list of mail addresses the user wants to add, made in Tresso's own apps or by an assistant through MCP
 * ({@see \App\Account\Import\MailAccountImports}). The user connects them one by one on the web app's page for the list;
 * nothing here connects anything.
 *
 * The addresses are personal data: the entries (address, provider hint, skipped, last failure) are one JSON list sealed
 * with the owner's field key for this row, so the table holds no address in the clear. A list lives
 * {@see self::LIFETIME} and is then swept.
 */
#[ORM\Entity(repositoryClass: MailAccountImportRepository::class)]
#[ORM\Index(name: 'mail_account_import_owner', columns: ['owner_id', 'expires_at'])]
#[ORM\Index(name: 'mail_account_import_expires', columns: ['expires_at'])]
class MailAccountImport
{
    public const string LIFETIME = '+24 hours';
    public const int MAX_ENTRIES = 50;

    #[ORM\Id]
    #[ORM\Column(type: UuidType::NAME)]
    private Uuid $id;

    #[ORM\ManyToOne]
    #[ORM\JoinColumn(nullable: false, onDelete: 'CASCADE')]
    private User $owner;

    /** The entries as JSON, sealed for this row ({@see \App\Account\Import\MailAccountImports}). */
    #[ORM\Column(type: Types::TEXT)]
    private string $sealedEntries = '';

    /** The app that made the list when it is not one of Tresso's own; the page names it. */
    #[ORM\Column(length: 200, nullable: true)]
    private ?string $createdBy;

    #[ORM\Column]
    private \DateTimeImmutable $createdAt;

    #[ORM\Column]
    private \DateTimeImmutable $expiresAt;

    public function __construct(User $owner, ?string $createdBy, \DateTimeImmutable $now)
    {
        $this->id = Uuid::v7();
        $this->owner = $owner;
        $this->createdBy = $createdBy;
        $this->createdAt = $now;
        $this->expiresAt = $now->modify(self::LIFETIME);
    }

    public function getId(): Uuid
    {
        return $this->id;
    }

    public function getOwner(): User
    {
        return $this->owner;
    }

    public function getSealedEntries(): string
    {
        return $this->sealedEntries;
    }

    public function sealEntries(string $sealed): void
    {
        $this->sealedEntries = $sealed;
    }

    public function getCreatedBy(): ?string
    {
        return $this->createdBy;
    }

    public function getCreatedAt(): \DateTimeImmutable
    {
        return $this->createdAt;
    }

    public function getExpiresAt(): \DateTimeImmutable
    {
        return $this->expiresAt;
    }

    public function isExpired(\DateTimeImmutable $now): bool
    {
        return $this->expiresAt <= $now;
    }
}
