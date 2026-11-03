<?php

declare(strict_types=1);

namespace App\Security\OAuth;

use App\Entity\OAuthConsent;
use App\Entity\User;
use App\Repository\OAuthConsentRepository;
use Doctrine\DBAL\LockMode;
use Doctrine\ORM\EntityManagerInterface;
use League\Bundle\OAuth2ServerBundle\Model\Client;
use Psr\Clock\ClockInterface;
use Symfony\Component\Uid\Uuid;

/**
 * Records what a user allowed an app. Two answers at the same time (two tabs, a double click) both succeed: the row is
 * made once (the database ignores the second insert), then locked while the scopes are added, so neither answer's
 * scopes get lost.
 */
final readonly class Consents
{
    public function __construct(
        private EntityManagerInterface $entityManager,
        private OAuthConsentRepository $consents,
        private ClockInterface $clock,
    ) {
    }

    /**
     * @param list<string> $scopes
     */
    public function allow(User $user, Client $client, array $scopes): OAuthConsent
    {
        // Checks the scopes before anything is written.
        $new = new OAuthConsent($user, $client, $scopes, $this->clock->now());

        return $this->entityManager->wrapInTransaction(function () use ($new, $user, $client, $scopes): OAuthConsent {
            $this->entityManager->getConnection()->executeStatement(
                'INSERT INTO oauth_consent (id, user_id, client_id, scopes, created_at) VALUES (:id, :user, :client, :scopes, :created) ON CONFLICT (user_id, client_id) DO NOTHING',
                [
                    'id' => $new->getId()->toRfc4122(),
                    'user' => $user->getId()->toRfc4122(),
                    'client' => $client->getIdentifier(),
                    'scopes' => json_encode($new->getScopes(), \JSON_THROW_ON_ERROR),
                    'created' => $new->getCreatedAt()->format('Y-m-d H:i:s'),
                ],
            );

            $consent = $this->consents->findOneFor($user, $client->getIdentifier())
                ?? throw new \LogicException('The consent was just made.');
            $this->entityManager->refresh($consent, LockMode::PESSIMISTIC_WRITE);
            $consent->allow($scopes);
            $this->entityManager->flush();

            return $consent;
        });
    }
}
