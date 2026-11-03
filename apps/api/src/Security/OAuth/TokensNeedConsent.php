<?php

declare(strict_types=1);

namespace App\Security\OAuth;

use App\Command\BootstrapOAuthClientsCommand;
use App\Repository\OAuthConsentRepository;
use App\Security\FirstPartyClients;
use League\Bundle\OAuth2ServerBundle\Event\ScopeResolveEvent;
use League\Bundle\OAuth2ServerBundle\OAuth2Events;
use League\OAuth2\Server\Exception\OAuthServerException;
use Symfony\Component\EventDispatcher\Attribute\AsEventListener;

/**
 * An app that is not ours gets a token (for an authorization code or a refresh token) only while the user's consent
 * covers every scope of it. Disconnecting revokes the app's tokens, but a code or refresh token used at the same
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
        $scopes = array_map(strval(...), $event->getScopes());
        if (null === $consent || !$consent->covers($scopes)) {
            throw OAuthServerException::invalidGrant('The user does not allow this app (any more).');
        }
    }
}
