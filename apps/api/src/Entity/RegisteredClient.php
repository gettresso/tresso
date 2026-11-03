<?php

declare(strict_types=1);

namespace App\Entity;

use App\Repository\RegisteredClientRepository;
use Doctrine\ORM\Mapping as ORM;
use League\Bundle\OAuth2ServerBundle\Model\Client;

/**
 * An OAuth2 client that registered itself through dynamic client registration (RFC 7591): an app that is not ours,
 * such as an MCP client. The client itself is the bundle's `oauth2_client` row; this marks it as registered and
 * records when it was last used, so registrations nobody ever used can be cleaned up. Deleting the client deletes this.
 */
#[ORM\Entity(repositoryClass: RegisteredClientRepository::class)]
#[ORM\Index(columns: ['created_at'])]
class RegisteredClient
{
    #[ORM\Id]
    #[ORM\OneToOne(targetEntity: Client::class)]
    #[ORM\JoinColumn(name: 'client_id', referencedColumnName: 'identifier', nullable: false, onDelete: 'CASCADE')]
    private Client $client;

    #[ORM\Column]
    private \DateTimeImmutable $createdAt;

    /** When a token was last issued to the client. */
    #[ORM\Column(nullable: true)]
    private ?\DateTimeImmutable $lastUsedAt = null;

    public function __construct(Client $client, \DateTimeImmutable $createdAt)
    {
        $this->client = $client;
        $this->createdAt = $createdAt;
    }

    public function getClient(): Client
    {
        return $this->client;
    }

    public function getCreatedAt(): \DateTimeImmutable
    {
        return $this->createdAt;
    }

    public function getLastUsedAt(): ?\DateTimeImmutable
    {
        return $this->lastUsedAt;
    }
}
