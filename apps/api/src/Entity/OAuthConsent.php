<?php

declare(strict_types=1);

namespace App\Entity;

use App\Repository\OAuthConsentRepository;
use App\Security\OAuth\ThirdPartyClients;
use Doctrine\DBAL\Types\Types;
use Doctrine\ORM\Mapping as ORM;
use League\Bundle\OAuth2ServerBundle\Model\Client;
use Symfony\Bridge\Doctrine\Types\UuidType;
use Symfony\Component\Uid\Uuid;

/**
 * A user allowed an app that is not ours to act for them with these scopes. While it holds every scope the app asks
 * for, the app is approved without the consent screen. Removing it (disconnecting the app) also revokes the app's
 * tokens for that user. Deleting the user or the client deletes it.
 */
#[ORM\Entity(repositoryClass: OAuthConsentRepository::class)]
#[ORM\Table(name: 'oauth_consent')]
#[ORM\UniqueConstraint(columns: ['user_id', 'client_id'])]
class OAuthConsent
{
    #[ORM\Id]
    #[ORM\Column(type: UuidType::NAME)]
    private Uuid $id;

    #[ORM\ManyToOne]
    #[ORM\JoinColumn(nullable: false, onDelete: 'CASCADE')]
    private User $user;

    #[ORM\ManyToOne(targetEntity: Client::class)]
    #[ORM\JoinColumn(name: 'client_id', referencedColumnName: 'identifier', nullable: false, onDelete: 'CASCADE')]
    private Client $client;

    /** @var list<string> */
    #[ORM\Column(type: Types::JSON)]
    private array $scopes = [];

    #[ORM\Column]
    private \DateTimeImmutable $createdAt;

    /** When a token was last issued to the app for this user. */
    #[ORM\Column(nullable: true)]
    private ?\DateTimeImmutable $lastUsedAt = null;

    /**
     * @param list<string> $scopes
     */
    public function __construct(User $user, Client $client, array $scopes, \DateTimeImmutable $createdAt)
    {
        if ([] === $scopes) {
            throw new \InvalidArgumentException('A consent needs at least one scope.');
        }
        $this->id = Uuid::v7();
        $this->user = $user;
        $this->client = $client;
        $this->createdAt = $createdAt;
        $this->allow($scopes);
    }

    public function getId(): Uuid
    {
        return $this->id;
    }

    public function getUser(): User
    {
        return $this->user;
    }

    public function getClient(): Client
    {
        return $this->client;
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

    public function getLastUsedAt(): ?\DateTimeImmutable
    {
        return $this->lastUsedAt;
    }

    /**
     * Whether the user already allowed every one of these scopes.
     *
     * @param list<string> $scopes
     */
    public function covers(array $scopes): bool
    {
        return [] === array_diff($scopes, $this->scopes);
    }

    /**
     * Adds scopes the user allowed; what was allowed before stays allowed, since the tokens issued for it still work.
     *
     * @param list<string> $scopes
     */
    public function allow(array $scopes): void
    {
        foreach ($scopes as $scope) {
            if (!ThirdPartyClients::mayAskFor($scope)) {
                throw new \InvalidArgumentException(\sprintf('An app that is not ours cannot hold the scope "%s".', $scope));
            }
        }
        $this->scopes = array_values(array_unique([...$this->scopes, ...$scopes]));
    }

    /**
     * Takes scopes back: the user left a WhatsApp scope unticked. Tokens issued for them must be ended by the caller.
     *
     * @param list<string> $scopes
     *
     * @return list<string> the scopes the consent held and no longer holds
     */
    public function withdraw(array $scopes): array
    {
        $withdrawn = array_values(array_intersect($this->scopes, $scopes));
        $this->scopes = array_values(array_diff($this->scopes, $scopes));

        return $withdrawn;
    }
}
