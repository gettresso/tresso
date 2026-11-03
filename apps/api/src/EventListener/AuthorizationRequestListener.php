<?php

declare(strict_types=1);

namespace App\EventListener;

use App\Security\FirstPartyClients;
use App\Security\OAuth\ConsentScreen;
use League\Bundle\OAuth2ServerBundle\Event\AuthorizationRequestResolveEvent;
use League\Bundle\OAuth2ServerBundle\OAuth2Events;
use Symfony\Component\EventDispatcher\Attribute\AsEventListener;

/**
 * Approves authorization requests from our own apps without a consent screen. Every other app (one that registered
 * itself, such as an MCP client) goes through the consent screen, which approves it directly when the user already
 * allowed all it asks for.
 */
#[AsEventListener(event: OAuth2Events::AUTHORIZATION_REQUEST_RESOLVE)]
final readonly class AuthorizationRequestListener
{
    public function __construct(private ConsentScreen $consentScreen)
    {
    }

    public function __invoke(AuthorizationRequestResolveEvent $event): void
    {
        if (FirstPartyClients::isFirstParty($event->getClient()->getIdentifier())) {
            $event->resolveAuthorization(AuthorizationRequestResolveEvent::AUTHORIZATION_APPROVED);

            return;
        }

        $this->consentScreen->resolve($event);
    }
}
