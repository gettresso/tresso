<?php

declare(strict_types=1);

namespace App\Entity;

use App\Enum\OAuthProvider;
use App\Enum\ProviderFeature;
use App\Enum\ProviderReturnTarget;
use Doctrine\DBAL\Types\Types;
use Doctrine\ORM\Mapping as ORM;

/**
 * A sign-in at a provider that is in progress: created when the user starts it, consumed once when the client hands in
 * the provider's answer.
 *
 * The OAuth "state" is a random secret only its hash is stored under, bound to the user who started it; only that
 * user's access token can finish it. The PKCE verifier stays here and never reaches the browser.
 */
#[ORM\Entity]
#[ORM\Index(columns: ['expires_at'])]
class ProviderAuthorizationRequest
{
    /** How long a user has to finish signing in at the provider. */
    public const string LIFETIME = '+15 minutes';

    /** SHA-256 of the state parameter, hex. */
    #[ORM\Id]
    #[ORM\Column(length: 64)]
    private string $stateHash;

    #[ORM\ManyToOne]
    #[ORM\JoinColumn(nullable: false, onDelete: 'CASCADE')]
    private User $owner;

    #[ORM\Column(length: 16, enumType: OAuthProvider::class)]
    private OAuthProvider $provider;

    /** @var list<string> {@see ProviderFeature} values */
    #[ORM\Column(type: Types::JSON)]
    private array $features;

    /** @var list<string> scopes asked for, as sent to the provider */
    #[ORM\Column(type: Types::JSON)]
    private array $requestedScopes;

    #[ORM\Column(length: 128)]
    private string $codeVerifier;

    /** Set when the user signs in again for an existing mail account. */
    #[ORM\Column(length: 36, nullable: true)]
    private ?string $mailAccountId;

    /** The address the user typed for a new account; the provider gets it as a login hint. */
    #[ORM\Column(length: 320, nullable: true)]
    private ?string $loginHint = null;

    /** Where the callback sends the provider's answer. */
    #[ORM\Column(length: 16, enumType: ProviderReturnTarget::class, options: ['default' => ProviderReturnTarget::Web->value])]
    private ProviderReturnTarget $returnTo;

    #[ORM\Column]
    private \DateTimeImmutable $expiresAt;

    /**
     * @param list<ProviderFeature> $features
     * @param list<string>          $requestedScopes
     */
    public function __construct(string $state, User $owner, OAuthProvider $provider, array $features, array $requestedScopes, string $codeVerifier, ?string $mailAccountId, ProviderReturnTarget $returnTo, ?string $loginHint = null)
    {
        $this->loginHint = $loginHint;
        $this->stateHash = self::hashState($state);
        $this->owner = $owner;
        $this->provider = $provider;
        $this->features = array_map(static fn (ProviderFeature $feature): string => $feature->value, $features);
        $this->requestedScopes = $requestedScopes;
        $this->codeVerifier = $codeVerifier;
        $this->mailAccountId = $mailAccountId;
        $this->returnTo = $returnTo;
        $this->expiresAt = new \DateTimeImmutable(self::LIFETIME);
    }

    public static function hashState(string $state): string
    {
        return hash('sha256', $state);
    }

    public function getStateHash(): string
    {
        return $this->stateHash;
    }

    public function getOwner(): User
    {
        return $this->owner;
    }

    public function getProvider(): OAuthProvider
    {
        return $this->provider;
    }

    /** @return list<ProviderFeature> */
    public function getFeatures(): array
    {
        return array_map(ProviderFeature::from(...), $this->features);
    }

    /** @return list<string> */
    public function getRequestedScopes(): array
    {
        return $this->requestedScopes;
    }

    public function getCodeVerifier(): string
    {
        return $this->codeVerifier;
    }

    public function getMailAccountId(): ?string
    {
        return $this->mailAccountId;
    }

    public function getLoginHint(): ?string
    {
        return $this->loginHint;
    }

    public function getReturnTo(): ProviderReturnTarget
    {
        return $this->returnTo;
    }

    public function getExpiresAt(): \DateTimeImmutable
    {
        return $this->expiresAt;
    }

    public function isExpired(\DateTimeImmutable $now = new \DateTimeImmutable()): bool
    {
        return $this->expiresAt <= $now;
    }
}
