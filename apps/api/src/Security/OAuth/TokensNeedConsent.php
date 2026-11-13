<?php

declare(strict_types=1);

namespace App\Security\OAuth;

use App\Command\BootstrapOAuthClientsCommand;
use App\Repository\OAuthConsentRepository;
use App\Security\FirstPartyClients;
use App\Security\Scope;
use League\Bundle\OAuth2ServerBundle\Event\ScopeResolveEvent;
use League\Bundle\OAuth2ServerBundle\OAuth2Events;
use League\Bundle\OAuth2ServerBundle\ValueObject\Scope as BundleScope;
use League\OAuth2\Server\Exception\OAuthServerException;
use Symfony\Component\EventDispatcher\Attribute\AsEventListener;

/**
 * An app that is not ours gets a token (for an authorization code or a refresh token) only while the user's consent
 * covers every scope of it that is not a chat scope; chat scopes the consent does not hold are dropped from the token
 * (the user left them unticked or took them back), and a token left with no scope is refused. League runs this through
 * `finalizeScopes()` for both the code exchange (`AuthCodeGrant`) and a refresh (`RefreshTokenGrant`). Disconnecting revokes the app's tokens, but a code or refresh token used at the same
 * moment could still slip past that; this check closes the gap, and it holds for tokens of any age.
 */
#[AsEventListener(event: OAuth2Events::SCOPE_RESOLVE)]
final readonly class TokensNeedConsent
{
    public function __construct(private OAuthConsentRepository $consents)
    {
    }

    /**
     * @throws OAuthServerException invalid_grant when the user does not (or no longer) allow it
     */
    public function __invoke(ScopeResolveEvent $event): void
    {
        $client = $event->getClient()->getIdentifier();
        if (FirstPartyClients::isFirstParty($client) || BootstrapOAuthClientsCommand::SYNC_WORKER === $client) {
            return;
        }
        $user = $event->getUserIdentifier();
        if (null === $user) {
            throw OAuthServerException::invalidGrant('Apps that are not Tresso\'s own only get tokens for a user.');
        }

        $consent = $this->consents->findOneForUserIdentifier((string) $user, $client);
        if (null === $consent) {
            throw OAuthServerException::invalidGrant('The user does not allow this app (any more).');
        }
        $chat = array_map(static fn (Scope $scope): string => $scope->value, Scope::chatScopes());
        $others = array_values(array_filter(array_map(strval(...), $event->getScopes()), static fn (string $scope): bool => !\in_array($scope, $chat, true)));
        if (!$consent->covers($others)) {
            throw OAuthServerException::invalidGrant('The user does not allow this app (any more).');
        }

        // The chat scopes the user did not tick (or took back) are left out of the token, not refused: the consent
        // screen cannot narrow the authorization code, so this is where the token gets only what the user allowed.
        $kept = array_values(array_filter(
            $event->getScopes(),
            static fn (BundleScope $scope): bool => !\in_array((string) $scope, $chat, true) || $consent->covers([(string) $scope]),
        ));
        if ([] === $kept) {
            throw OAuthServerException::invalidGrant('The user does not allow this app (any more).');
        }
        if (\count($kept) !== \count($event->getScopes())) {
            $event->setScopes(...$kept);
        }
    }
}
