<?php

declare(strict_types=1);

namespace App\Security\OAuth;

use App\Entity\OAuthConsent;
use Doctrine\DBAL\LockMode;
use Doctrine\ORM\EntityManagerInterface;
use League\Bundle\OAuth2ServerBundle\Model\AccessToken;
use League\Bundle\OAuth2ServerBundle\Model\AuthorizationCode;
use League\Bundle\OAuth2ServerBundle\Model\RefreshToken;

/**
 * Narrowing and disconnecting an app that is not ours.
 *
 * Narrowing keeps the app connected and switches off the granted scopes the user no longer allows: the consent keeps
 * both sets, and every request of the app is checked against them ({@see NarrowedScopes}), so tokens already issued lose
 * the scopes at once and get them back when they are switched on again. No token is revoked for it.
 *
 * Disconnecting: the consent goes, and every access token, refresh token and authorization code the app holds for that
 * user is revoked at once, in one transaction. The app has to ask again, and the user sees the consent screen again.
 */
final readonly class ConnectedApps
{
    public function __construct(private EntityManagerInterface $entityManager)
    {
    }

    /**
     * Lets the app use only these granted scopes; the others are switched off. Locked, so two changes at once both end
     * in one of the two sets, never a mix.
     *
     * @param list<string> $allowed
     */
    public function narrow(OAuthConsent $consent, array $allowed): OAuthConsent
    {
        return $this->entityManager->wrapInTransaction(function () use ($consent, $allowed): OAuthConsent {
            $this->entityManager->refresh($consent, LockMode::PESSIMISTIC_WRITE);
            $consent->narrow(array_values(array_intersect($allowed, $consent->getScopes())));
            $this->entityManager->flush();

            return $consent;
        });
    }

    public function disconnect(OAuthConsent $consent): void
    {
        $userIdentifier = $consent->getUser()->getUserIdentifier();
        $client = $consent->getClient()->getIdentifier();

        $this->entityManager->wrapInTransaction(function () use ($consent, $userIdentifier, $client): void {
            $tokensOfTheApp = $this->entityManager->createQueryBuilder()
                ->select('at.identifier')
                ->from(AccessToken::class, 'at')
                ->where('at.client = :client')
                ->andWhere('at.userIdentifier = :user');

            $refresh = $this->entityManager->createQueryBuilder();
            $refresh->update(RefreshToken::class, 'rt')
                ->set('rt.revoked', ':revoked')
                ->where($refresh->expr()->in('rt.accessToken', $tokensOfTheApp->getDQL()))
                ->setParameter('revoked', true)
                ->setParameter('client', $client, 'string')
                ->setParameter('user', $userIdentifier)
                ->getQuery()
                ->execute();

            foreach ([AccessToken::class, AuthorizationCode::class] as $class) {
                $this->entityManager->createQueryBuilder()
                    ->update($class, 't')
                    ->set('t.revoked', ':revoked')
                    ->where('t.client = :client')
                    ->andWhere('t.userIdentifier = :user')
                    ->setParameter('revoked', true)
                    ->setParameter('client', $client, 'string')
                    ->setParameter('user', $userIdentifier)
                    ->getQuery()
                    ->execute();
            }

            $this->entityManager->remove($consent);
            $this->entityManager->flush();
        });
    }
}
