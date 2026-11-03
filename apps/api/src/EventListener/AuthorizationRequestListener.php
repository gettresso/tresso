<?php

declare(strict_types=1);

namespace App\EventListener;

use App\Security\FirstPartyClients;
use League\Bundle\OAuth2ServerBundle\Event\AuthorizationRequestResolveEvent;
use League\Bundle\OAuth2ServerBundle\OAuth2Events;
use Symfony\Component\EventDispatcher\Attribute\AsEventListener;

/**
 * Approves authorization requests from our own apps without a consent screen.
 *
 * Third-party clients (public API, MCP) get a consent screen in the platform phase; until then they are denied.
 */
#[AsEventListener(event: OAuth2Events::AUTHORIZATION_REQUEST_RESOLVE)]
final class AuthorizationRequestListener
{
    public function __invoke(AuthorizationRequestResolveEvent $event): void
    {
        $event->resolveAuthorization(FirstPartyClients::isFirstParty($event->getClient()->getIdentifier()));
    }
}
