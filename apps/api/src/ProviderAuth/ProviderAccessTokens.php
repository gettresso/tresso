<?php

declare(strict_types=1);

namespace App\ProviderAuth;

use App\Entity\ProviderGrant;
use App\Enum\CalendarSyncStatus;
use App\Enum\MailAccountStatus;
use App\Enum\OAuthProvider;
use App\Enum\ProviderFeature;
use App\Repository\MailAccountRepository;
use App\Security\Crypto\CredentialVault;
use Doctrine\DBAL\LockMode;
use Doctrine\ORM\EntityManagerInterface;

/**
 * Keeps a grant's tokens: stores what a sign-in returned and hands out access tokens, refreshing them at the provider
 * when they are about to expire. The refresh token never leaves this class.
 *
 * Refreshing locks the grant row, so two callers (a sync worker and, later, the calendar) never refresh at the same
 * time: Microsoft replaces the refresh token on every refresh, and a lost replacement would end the grant.
 */
final readonly class ProviderAccessTokens
{
    /** Access tokens closer than this to expiry are refreshed before they are handed out. */
    private const int REFRESH_MARGIN_SECONDS = 300;

    /** A token reported as rejected is replaced, unless it was issued this recently (then the report is stale). */
    private const int REJECTION_GRACE_SECONDS = 60;

    public function __construct(
        private EntityManagerInterface $entityManager,
        private CredentialVault $vault,
        private ProviderClient $client,
        private MailAccountRepository $mailAccounts,
    ) {
    }

    /**
     * Stores the tokens of a sign-in. Providers may omit the refresh token on a repeated consent; the previous one
     * then stays valid and is kept.
     */
    public function store(ProviderGrant $grant, TokenSet $tokens): void
    {
        $refreshToken = $tokens->refreshToken ?? $this->refreshToken($grant)
            ?? throw new \LogicException('Callers check that the tokens or the grant hold a refresh token.');

        $this->vault->sealGrant($grant, [
            'refreshToken' => $refreshToken,
            'accessToken' => $tokens->accessToken,
            'accessTokenExpiresAt' => $tokens->expiresAt->getTimestamp(),
            'accessTokenIssuedAt' => time(),
        ]);
    }

    /**
     * An access token for the feature, valid for at least a few more minutes.
     *
     * @param bool $rejected the caller's last token was refused by the provider, so a cached one is not good enough
     *
     * A grant without a feature's scopes stops the mail accounts for mail (mail is what they are for), but only
     * refuses the token for a feature the user allows separately, such as calendars.
     *
     * @throws ReauthorizationRequired
     * @throws FeatureNotGranted
     * @throws ProviderUnavailable
     */
    public function accessToken(ProviderGrant $grant, ProviderFeature $feature, bool $rejected = false): AccessToken
    {
        // Nothing is thrown inside the transaction: an exception there closes the entity manager.
        $token = $this->entityManager->wrapInTransaction(function () use ($grant, $feature, $rejected): AccessToken|ProviderUnavailable|FeatureNotGranted|null {
            $this->entityManager->refresh($grant, LockMode::PESSIMISTIC_WRITE);
            $provider = $grant->getProvider();

            if ($grant->isRevoked()) {
                return null;
            }
            if (!$grant->hasScopes(ProviderScopes::required($provider, $feature))) {
                return $this->notGranted($grant, $feature);
            }

            $tokens = $this->vault->openGrant($grant);
            $accessToken = \is_string($tokens['accessToken'] ?? null) ? $tokens['accessToken'] : null;
            $expiresAt = \is_int($tokens['accessTokenExpiresAt'] ?? null) ? $tokens['accessTokenExpiresAt'] : 0;
            $issuedAt = \is_int($tokens['accessTokenIssuedAt'] ?? null) ? $tokens['accessTokenIssuedAt'] : 0;
            $now = time();
            if (null !== $accessToken && $expiresAt - self::REFRESH_MARGIN_SECONDS > $now && (!$rejected || $issuedAt > $now - self::REJECTION_GRACE_SECONDS)) {
                return new AccessToken($accessToken, new \DateTimeImmutable('@'.$expiresAt));
            }

            $refreshToken = \is_string($tokens['refreshToken'] ?? null) ? $tokens['refreshToken'] : throw new \UnexpectedValueException('The grant has no refresh token.');
            $covered = ProviderScopes::coveredFeatures($provider, $grant->getScopes());
            try {
                $refreshed = $this->client->refresh($provider, $refreshToken, ProviderScopes::request($provider, $covered));
            } catch (GrantRejected) {
                $refreshed = $this->refreshForMail($grant, $refreshToken, $covered);
                if (null === $refreshed) {
                    $grant->revoke();
                    $this->requireSignIn($grant, \sprintf('%s no longer lets Tresso use this account. Sign in with %s again.', $provider->label(), $provider->label()));

                    return null;
                }
            } catch (ProviderUnavailable $e) {
                return $e;
            }

            if (null !== $refreshed->scopes) {
                $grant->updateScopes($refreshed->scopes);
            }
            $this->store($grant, $refreshed);
            $this->entityManager->flush();

            if (!$grant->hasScopes(ProviderScopes::required($provider, $feature))) {
                return $this->notGranted($grant, $feature);
            }

            return new AccessToken($refreshed->accessToken, $refreshed->expiresAt);
        });

        if ($token instanceof ProviderUnavailable || $token instanceof FeatureNotGranted) {
            throw $token;
        }

        return $token ?? throw new ReauthorizationRequired(\sprintf('Sign in with %s again to keep using this account.', $grant->getProvider()->label()));
    }

    /**
     * Microsoft refreshes for the scopes asked for: a user (or admin) who withdrew the calendar consent makes a refresh
     * for mail and calendars fail, while mail alone still works. The grant then keeps mail, loses the calendars, and
     * its accounts say calendars are not allowed. Null when mail alone is refused too, or there is nothing else to try.
     *
     * @param list<ProviderFeature> $covered
     */
    private function refreshForMail(ProviderGrant $grant, #[\SensitiveParameter] string $refreshToken, array $covered): ?TokenSet
    {
        $provider = $grant->getProvider();
        if (OAuthProvider::Microsoft !== $provider || !\in_array(ProviderFeature::Mail, $covered, true) || [ProviderFeature::Mail] === $covered) {
            return null;
        }
        try {
            $refreshed = $this->client->refresh($provider, $refreshToken, ProviderScopes::request($provider, [ProviderFeature::Mail]));
        } catch (GrantRejected|ProviderUnavailable) {
            return null;
        }
        $grant->updateScopes($refreshed->scopes ?? ProviderScopes::required($provider, ProviderFeature::Mail));
        foreach ($this->mailAccounts->findByProviderGrant($grant) as $account) {
            $account->setCalendarStatus(CalendarSyncStatus::NotGranted, \sprintf('%s no longer lets Tresso use the calendars of this account. Allow calendar access to sync them again.', $provider->label()));
        }

        return $refreshed;
    }

    /**
     * The refresh token the grant holds, if any.
     */
    public function refreshToken(ProviderGrant $grant): ?string
    {
        if ('' === $grant->getEncryptedTokens()) {
            return null;
        }
        $refreshToken = $this->vault->openGrant($grant)['refreshToken'] ?? null;

        return \is_string($refreshToken) ? $refreshToken : null;
    }

    /**
     * What an account's status says when the grant does not cover a feature other than mail.
     */
    public static function notGrantedDetail(OAuthProvider $provider, ProviderFeature $feature): string
    {
        return \sprintf('Tresso is not allowed to use the %s of this account yet. Allow it by signing in with %s again.', $feature->label(), $provider->label());
    }

    private function notGranted(ProviderGrant $grant, ProviderFeature $feature): ?FeatureNotGranted
    {
        $provider = $grant->getProvider();
        if (ProviderFeature::Mail !== $feature) {
            return new FeatureNotGranted(self::notGrantedDetail($provider, $feature));
        }
        $this->requireSignIn($grant, \sprintf('Tresso is not allowed to use the %s of this account. Sign in with %s again and allow it.', $feature->value, $provider->label()));

        return null;
    }

    /**
     * Stops the grant's mail accounts with a message the user can act on. Paused accounts stay paused.
     */
    private function requireSignIn(ProviderGrant $grant, string $detail): void
    {
        foreach ($this->mailAccounts->findByProviderGrant($grant) as $account) {
            if (MailAccountStatus::Paused !== $account->getStatus()) {
                $account->setStatus(MailAccountStatus::AuthFailed, $detail);
            }
        }
        $this->entityManager->flush();
    }
}
