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
 *
 * Two sets are kept apart: the scopes the user granted on the consent screen ({@see getScopes()}), and among them those
 * the user switched off later in Tresso ({@see getDisabledScopes()}). What the app may use is the first without the
 * second ({@see getAllowedScopes()}); every request of the app is narrowed to it
 * ({@see \App\Security\OAuth\NarrowedScopes}). A scope can only be switched back on when it was granted; anything
 * more needs the consent screen again.
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

    /**
     * Granted scopes the user switched off, always a part of {@see $scopes}.
     *
     * @var list<string>
     */
    #[ORM\Column(type: Types::JSON, options: ['default' => '[]'])]
    private array $disabledScopes = [];

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

    /**
     * What the user granted on the consent screen, switched off or not.
     *
     * @return list<string>
     */
    public function getScopes(): array
    {
        return $this->scopes;
    }

    /**
     * Granted scopes the user switched off in Tresso.
     *
     * @return list<string>
     */
    public function getDisabledScopes(): array
    {
        return $this->disabledScopes;
    }

    /**
     * What the app may use now: the granted scopes without those switched off.
     *
     * @return list<string>
     */
    public function getAllowedScopes(): array
    {
        return array_values(array_diff($this->scopes, $this->disabledScopes));
    }

    /**
     * Sets what the app may use to these granted scopes: the others are switched off, these (back) on.
     *
     * @param list<string> $allowed
     *
     * @return list<string> the scopes that were allowed before and are switched off now
     *
     * @throws \InvalidArgumentException when a scope was never granted
     */
    public function narrow(array $allowed): array
    {
        $beyond = array_values(array_diff($allowed, $this->scopes));
        if ([] !== $beyond) {
            throw new \InvalidArgumentException(\sprintf('The user did not grant "%s" on the consent screen.', implode('", "', $beyond)));
        }
        $before = $this->getAllowedScopes();
        $this->disabledScopes = array_values(array_diff($this->scopes, $allowed));

        return array_values(array_diff($before, $allowed));
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
     * A scope the user switched off in Tresso stays off when an app asks for it again on the consent screen: only the
     * switch turns it back on, so the choice made in Tresso is never undone by an app that signs in again.
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
        $this->disabledScopes = array_values(array_diff($this->disabledScopes, $scopes));

        return $withdrawn;
    }
}
