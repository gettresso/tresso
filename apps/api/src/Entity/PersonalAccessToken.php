<?php

declare(strict_types=1);

namespace App\Entity;

use App\Repository\PersonalAccessTokenRepository;
use App\Security\Scope;
use Doctrine\DBAL\Types\Types;
use Doctrine\ORM\Mapping as ORM;
use Symfony\Bridge\Doctrine\Types\UuidType;
use Symfony\Component\Uid\Uuid;

/**
 * A personal access token: a secret a user makes for their own scripts and tools, sent as a Bearer token. Only the
 * SHA-256 of the secret is stored; the secret itself is shown once, when it is made. Revoking keeps the row (so the list
 * can still show it) until the cleanup removes it.
 */
#[ORM\Entity(repositoryClass: PersonalAccessTokenRepository::class)]
#[ORM\Index(columns: ['owner_id', 'created_at'])]
class PersonalAccessToken
{
    #[ORM\Id]
    #[ORM\Column(type: UuidType::NAME)]
    private Uuid $id;

    #[ORM\ManyToOne]
    #[ORM\JoinColumn(nullable: false, onDelete: 'CASCADE')]
    private User $owner;

    #[ORM\Column(length: 80)]
    private string $name;

    /** Hex SHA-256 of the whole secret. */
    #[ORM\Column(length: 64, unique: true)]
    private string $tokenHash;

    /** The start of the secret, shown so the user can tell their tokens apart. */
    #[ORM\Column(length: 32)]
    private string $prefix;

    /** @var list<string> */
    #[ORM\Column(type: Types::JSON)]
    private array $scopes;

    #[ORM\Column]
    private \DateTimeImmutable $createdAt;

    #[ORM\Column]
    private \DateTimeImmutable $expiresAt;

    #[ORM\Column(nullable: true)]
    private ?\DateTimeImmutable $lastUsedAt = null;

    #[ORM\Column(nullable: true)]
    private ?\DateTimeImmutable $revokedAt = null;

    /**
     * @param list<Scope> $scopes
     */
    public function __construct(User $owner, string $name, string $tokenHash, string $prefix, array $scopes, \DateTimeImmutable $createdAt, \DateTimeImmutable $expiresAt)
    {
        if ([] === $scopes) {
            throw new \InvalidArgumentException('A personal access token needs at least one scope.');
        }
        foreach ($scopes as $scope) {
            if (!\in_array($scope, Scope::personalAccessTokenScopes(), true)) {
                throw new \InvalidArgumentException(\sprintf('A personal access token cannot hold the scope "%s".', $scope->value));
            }
        }
        if ($expiresAt <= $createdAt) {
            throw new \InvalidArgumentException('A personal access token must expire after it was made.');
        }

        $this->id = Uuid::v7();
        $this->owner = $owner;
        $this->name = $name;
        $this->tokenHash = $tokenHash;
        $this->prefix = $prefix;
        $this->scopes = array_values(array_unique(array_map(static fn (Scope $scope): string => $scope->value, $scopes)));
        $this->createdAt = $createdAt;
        $this->expiresAt = $expiresAt;
    }

    public function getId(): Uuid
    {
        return $this->id;
    }

    public function getOwner(): User
    {
        return $this->owner;
    }

    public function getName(): string
    {
        return $this->name;
    }

    public function getPrefix(): string
    {
        return $this->prefix;
    }

    /** @return list<string> */
    public function getScopes(): array
    {
        return $this->scopes;
    }

    public function getCreatedAt(): \DateTimeImmutable
    {
        return $this->createdAt;
    }

    public function getExpiresAt(): \DateTimeImmutable
    {
        return $this->expiresAt;
    }

    public function getLastUsedAt(): ?\DateTimeImmutable
    {
        return $this->lastUsedAt;
    }

    public function getRevokedAt(): ?\DateTimeImmutable
    {
        return $this->revokedAt;
    }

    public function isUsableAt(\DateTimeImmutable $now): bool
    {
        return null === $this->revokedAt && $now < $this->expiresAt;
    }

    /** Revoking twice keeps the first time. */
    public function revoke(\DateTimeImmutable $at): void
    {
        $this->revokedAt ??= $at;
    }
}
