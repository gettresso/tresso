<?php

declare(strict_types=1);

namespace App\ProviderAuth;

use App\Entity\MailAccount;
use App\Entity\ProviderAuthorizationRequest;
use App\Entity\ProviderGrant;
use App\Entity\User;
use App\Enum\CalendarSyncStatus;
use App\Enum\MailAccountStatus;
use App\Enum\OAuthProvider;
use App\Enum\ProviderFeature;
use App\Realtime\RealtimeNotifier;
use App\Repository\MailAccountRepository;
use App\Repository\ProviderGrantRepository;
use Doctrine\ORM\EntityManagerInterface;
use Psr\Log\LoggerInterface;

/**
 * Connects provider accounts through the OAuth authorization code flow with PKCE.
 *
 * 1. {@see self::start()}: a signed-in client asks to connect; the API stores the state (hashed) and PKCE verifier
 *    bound to that user and returns the provider's authorization URL. The client sends the browser there.
 * 2. The provider redirects the browser to /connect/<provider>/callback on the API, which only passes the answer on to
 *    the web app ({@see self::returnFrom()}). It needs no API browser session: that session lives far shorter than
 *    the web app's sign-in, so requiring it sent users back from the provider to Tresso's sign-in page.
 * 3. The web app hands the answer to the API with its own access token ({@see self::complete()}), which must belong to
 *    the user who started: a link someone else started cannot connect your provider account to their Tresso account.
 *    The code is redeemed with the verifier, the grant is created or updated, and each feature does its part: for
 *    mail, the Gmail or Microsoft 365 account is created or signed in again.
 */
final readonly class ProviderConnector
{
    public const string ADD_PATH = '/settings/accounts/new';
    public const string ACCOUNTS_PATH = '/settings/accounts';

    public function __construct(
        private EntityManagerInterface $entityManager,
        private ProviderSettings $settings,
        private ProviderClient $client,
        private ProviderAccessTokens $tokens,
        private ProviderGrantRepository $grants,
        private MailAccountRepository $mailAccounts,
        private RealtimeNotifier $notifier,
        private LoggerInterface $logger,
    ) {
    }

    /**
     * @param list<ProviderFeature> $features
     * @param MailAccount|null      $mailAccount signing in again for this account
     *
     * @return array{url: string, expiresAt: \DateTimeImmutable}
     */
    public function start(User $owner, OAuthProvider $provider, array $features, ?MailAccount $mailAccount): array
    {
        if (!$this->settings->isConfigured($provider)) {
            throw new \LogicException(\sprintf('%s sign-in is not configured.', $provider->label()));
        }

        // Ask again for what the grant already covers, so the new tokens keep serving every feature.
        $grant = $mailAccount?->getProviderGrant();
        if (null !== $grant) {
            $features = [...$features, ...ProviderScopes::coveredFeatures($provider, $grant->getScopes())];
        }
        $features = array_values(array_unique($features, \SORT_REGULAR));
        $scopes = ProviderScopes::request($provider, $features);

        $state = self::randomToken();
        $verifier = self::randomToken();
        $request = new ProviderAuthorizationRequest($state, $owner, $provider, $features, $scopes, $verifier, $mailAccount?->getId()->toRfc4122());

        $this->entityManager->createQuery('DELETE FROM '.ProviderAuthorizationRequest::class.' r WHERE r.expiresAt <= :now')
            ->setParameter('now', new \DateTimeImmutable())
            ->execute();
        $this->entityManager->persist($request);
        $this->entityManager->flush();

        $challenge = rtrim(strtr(base64_encode(hash('sha256', $verifier, true)), '+/', '-_'), '=');

        return [
            'url' => $this->client->authorizationUrl($provider, $scopes, $state, $challenge, $mailAccount?->getEmailAddress()),
            'expiresAt' => $request->getExpiresAt(),
        ];
    }

    /**
     * Where the provider's redirect sends the browser next: the web app page the sign-in started from, with the
     * provider's answer (state plus code or error) for the web app to finish with {@see self::complete()}. Writes
     * nothing and redeems nothing, so it needs no signed-in user; an unknown or expired state ends here.
     *
     * @param array<string, mixed> $query the callback's query parameters
     */
    public function returnFrom(OAuthProvider $provider, array $query): ConnectResult
    {
        $state = $query['state'] ?? null;
        $request = \is_string($state) && '' !== $state ? $this->entityManager->find(ProviderAuthorizationRequest::class, ProviderAuthorizationRequest::hashState($state)) : null;
        if (!\is_string($state) || null === $request || $request->isExpired() || $request->getProvider() !== $provider) {
            return new ConnectResult(self::ADD_PATH, ['provider' => $provider->value, 'connectError' => ConnectError::Expired->value]);
        }

        $answer = ['provider' => $provider->value, 'state' => $state];
        foreach (['code', 'error'] as $key) {
            if (\is_string($query[$key] ?? null) && '' !== $query[$key]) {
                $answer[$key] = $query[$key];
            }
        }

        return new ConnectResult(null !== $request->getMailAccountId() ? self::ACCOUNTS_PATH : self::ADD_PATH, $answer);
    }

    /**
     * Finishes a sign-in with the provider's answer, for the signed-in user who hands it in. Never throws for things
     * the user or provider did: the outcome says what happened.
     */
    public function complete(User $user, OAuthProvider $provider, string $state, ?string $code, ?string $error): ConnectOutcome
    {
        $request = '' !== $state ? $this->consume($state) : null;

        try {
            if (null === $request || $request->isExpired() || $request->getProvider() !== $provider) {
                throw new ConnectFailed(ConnectError::Expired);
            }
            if (!$request->getOwner()->getId()->equals($user->getId())) {
                throw new ConnectFailed(ConnectError::DifferentUser);
            }
            if (null !== $error && '' !== $error) {
                throw new ConnectFailed('access_denied' === $error ? ConnectError::Denied : ConnectError::Failed, \sprintf('The provider answered %s.', $error));
            }
            if (null === $code || '' === $code) {
                throw new ConnectFailed(ConnectError::Failed, 'The provider sent no code.');
            }

            return $this->connect($request, $code);
        } catch (ConnectFailed $e) {
            $this->logger->info('Connecting a provider account failed.', ['provider' => $provider->value, 'error' => $e->error->value, 'reason' => $e->getMessage()]);

            return ConnectOutcome::failed($e->error);
        }
    }

    /**
     * Removes the request, so a state works once.
     */
    private function consume(string $state): ?ProviderAuthorizationRequest
    {
        $request = $this->entityManager->find(ProviderAuthorizationRequest::class, ProviderAuthorizationRequest::hashState($state));
        if (null !== $request) {
            $this->entityManager->remove($request);
            $this->entityManager->flush();
        }

        return $request;
    }

    private function connect(ProviderAuthorizationRequest $request, string $code): ConnectOutcome
    {
        $provider = $request->getProvider();
        try {
            $tokens = $this->client->redeemCode($provider, $code, $request->getCodeVerifier(), $request->getRequestedScopes());
            $identity = $this->client->identify($provider, $tokens);
        } catch (GrantRejected $e) {
            throw new ConnectFailed(ConnectError::Expired, $e->getMessage(), $e);
        } catch (UnverifiedAddress $e) {
            throw new ConnectFailed(ConnectError::UnverifiedAddress, $e->getMessage(), $e);
        } catch (NoMailbox $e) {
            throw new ConnectFailed(ConnectError::NoMailbox, $e->getMessage(), $e);
        } catch (ProviderUnavailable $e) {
            throw new ConnectFailed(ConnectError::Failed, $e->getMessage(), $e);
        }

        $granted = $tokens->scopes ?? ProviderScopes::normalize($provider, implode(' ', $request->getRequestedScopes()));
        // Mail is what an account is for; calendars the user may leave unticked (Google asks per scope) and allow later.
        foreach ($request->getFeatures() as $feature) {
            if ([] === array_diff(ProviderScopes::required($provider, $feature), $granted)) {
                continue;
            }
            if (ProviderFeature::Mail === $feature) {
                throw new ConnectFailed(ConnectError::ScopesMissing, \sprintf('The %s scopes were not granted.', $feature->value));
            }
            $this->logger->info('A provider sign-in left out a feature.', ['provider' => $provider->value, 'feature' => $feature->value]);
        }

        $owner = $request->getOwner();
        $forMail = \in_array(ProviderFeature::Mail, $request->getFeatures(), true);
        // Everything that can refuse the sign-in is checked before the transaction: nothing may be written then, and
        // an exception inside it would close the entity manager.
        $mailAccount = $forMail ? $this->mailAccountFor($request, $identity) : null;
        $grant = $this->grants->findOneFor($owner, $provider, $identity->subject);
        if (null === $tokens->refreshToken && (null === $grant || null === $this->tokens->refreshToken($grant))) {
            throw new ConnectFailed(ConnectError::Failed, \sprintf('%s returned no refresh token.', $provider->label()));
        }

        // One transaction for the grant and the account, so change numbers for client sync commit in order.
        return $this->entityManager->wrapInTransaction(function () use ($request, $tokens, $identity, $granted, $grant, $mailAccount, $forMail): ConnectOutcome {
            $owner = $request->getOwner();
            $provider = $request->getProvider();

            if (null === $grant) {
                $grant = new ProviderGrant($owner, $provider, $identity->subject, $identity->emailAddress);
                $this->entityManager->persist($grant);
            }
            // Google reports every scope the grant holds (include_granted_scopes). Microsoft reports what this request
            // asked for, while its refresh token keeps working for everything consented before.
            $scopes = OAuthProvider::Microsoft === $provider ? array_values(array_unique([...$grant->getScopes(), ...$granted])) : $granted;
            sort($scopes);
            $grant->authorize($identity->emailAddress, $scopes);
            $this->tokens->store($grant, $tokens);
            $this->entityManager->flush();

            if (!$forMail) {
                return ConnectOutcome::grant($grant->getId()->toRfc4122());
            }

            if (null === $mailAccount) {
                $mailAccount = new MailAccount($owner, $identity->emailAddress, self::displayName($identity), $provider->mailProvider());
                $this->entityManager->persist($mailAccount);
            }
            $previousGrant = $mailAccount->getProviderGrant();
            $mailAccount->linkProviderGrant($grant);
            if (MailAccountStatus::AuthFailed === $mailAccount->getStatus() || MailAccountStatus::Error === $mailAccount->getStatus()) {
                $mailAccount->setStatus(MailAccountStatus::Active);
            }
            $this->entityManager->flush();

            if (null !== $previousGrant && $previousGrant !== $grant && [] === $this->mailAccounts->findByProviderGrant($previousGrant)) {
                $this->entityManager->remove($previousGrant);
                $this->entityManager->flush();
            }

            if (\in_array(ProviderFeature::Calendar, ProviderScopes::coveredFeatures($provider, $grant->getScopes()), true)) {
                if (CalendarSyncStatus::NotGranted === $mailAccount->getCalendarStatus()) {
                    $mailAccount->setCalendarStatus(CalendarSyncStatus::Unknown);
                    $this->entityManager->flush();
                }
                // The worker holding the account waits for calendar access; this wakes it.
                $this->notifier->outboxDue($mailAccount->getId());
            }

            return ConnectOutcome::connected($mailAccount->getId()->toRfc4122());
        });
    }

    /**
     * The existing account this sign-in is for, or null when a new one is to be created.
     */
    private function mailAccountFor(ProviderAuthorizationRequest $request, ProviderIdentity $identity): ?MailAccount
    {
        $owner = $request->getOwner();
        $mailProvider = $request->getProvider()->mailProvider();

        $requestedId = $request->getMailAccountId();
        if (null !== $requestedId) {
            $account = $this->mailAccounts->findOneOwnedBy($owner, $requestedId);
            if (null === $account || $account->getProvider() !== $mailProvider) {
                throw new ConnectFailed(ConnectError::Expired, 'The account to sign in again for is gone.');
            }
            if ($account->getEmailAddress() !== mb_strtolower($identity->emailAddress)) {
                throw new ConnectFailed(ConnectError::WrongAccount, 'Signed in with another provider account.');
            }

            return $account;
        }

        $account = $this->mailAccounts->findOneByOwnerAndAddress($owner, $identity->emailAddress);
        if (null !== $account && $account->getProvider() !== $mailProvider) {
            throw new ConnectFailed(ConnectError::AlreadyConnected, 'The address is connected with another provider.');
        }

        return $account;
    }

    private static function displayName(ProviderIdentity $identity): string
    {
        $name = $identity->displayName ?? strstr($identity->emailAddress, '@', true);

        return mb_substr('' === $name || false === $name ? $identity->emailAddress : $name, 0, 120);
    }

    private static function randomToken(): string
    {
        return rtrim(strtr(base64_encode(random_bytes(32)), '+/', '-_'), '=');
    }
}
