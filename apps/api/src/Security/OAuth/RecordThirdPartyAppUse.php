<?php

declare(strict_types=1);

namespace App\Security\OAuth;

use App\Entity\OAuthConsent;
use App\Entity\RegisteredClient;
use App\Entity\User;
use App\Command\BootstrapOAuthClientsCommand;
use App\Security\FirstPartyClients;
use Doctrine\ORM\EntityManagerInterface;
use League\OAuth2\Server\RequestAccessTokenEvent;
use League\OAuth2\Server\RequestEvent;
use Psr\Clock\ClockInterface;
use Symfony\Component\EventDispatcher\Attribute\AsEventListener;

/**
 * Records when an app that is not ours last got a token, for a user (the connected apps list) and as a client (so a
 * registration that was used is never cleaned up). Tokens are issued on sign-in and on every refresh, at least once an
 * hour while the app is in use, so this is the last use to within the lifetime of an access token.
 */
#[AsEventListener(event: RequestEvent::ACCESS_TOKEN_ISSUED)]
final readonly class RecordThirdPartyAppUse
{
    public function __construct(
        private EntityManagerInterface $entityManager,
        private ClockInterface $clock,
    ) {
    }

    public function __invoke(RequestAccessTokenEvent $event): void
    {
        $token = $event->getAccessToken();
        $clientIdentifier = $token->getClient()->getIdentifier();
        if (FirstPartyClients::isFirstParty($clientIdentifier) || BootstrapOAuthClientsCommand::SYNC_WORKER === $clientIdentifier) {
            return;
        }
        $now = $this->clock->now();

        $this->entityManager->createQueryBuilder()
            ->update(RegisteredClient::class, 'r')
            ->set('r.lastUsedAt', ':now')
            ->where('r.client = :client')
            ->setParameter('now', $now)
            ->setParameter('client', $clientIdentifier)
            ->getQuery()
            ->execute();

        $userIdentifier = $token->getUserIdentifier();
        if (null === $userIdentifier) {
            return;
        }
        $this->entityManager->createQueryBuilder()
            ->update(OAuthConsent::class, 'c')
            ->set('c.lastUsedAt', ':now')
            ->where('c.client = :client')
            ->andWhere('IDENTITY(c.user) IN (SELECT u.id FROM '.User::class.' u WHERE u.email = :email)')
            ->setParameter('now', $now)
            ->setParameter('client', $clientIdentifier)
            ->setParameter('email', (string) $userIdentifier)
            ->getQuery()
            ->execute();
    }
}
