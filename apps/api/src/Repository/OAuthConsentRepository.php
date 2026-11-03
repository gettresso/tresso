<?php

declare(strict_types=1);

namespace App\Repository;

use App\Entity\OAuthConsent;
use App\Entity\User;
use Doctrine\Bundle\DoctrineBundle\Repository\ServiceEntityRepository;
use Doctrine\Persistence\ManagerRegistry;
use Symfony\Component\Uid\Uuid;

/**
 * @extends ServiceEntityRepository<OAuthConsent>
 */
class OAuthConsentRepository extends ServiceEntityRepository
{
    public function __construct(ManagerRegistry $registry)
    {
        parent::__construct($registry, OAuthConsent::class);
    }

    public function findOneFor(User $user, string $clientIdentifier): ?OAuthConsent
    {
        return $this->findOneBy(['user' => $user, 'client' => $clientIdentifier]);
    }

    /** @return list<OAuthConsent> newest first, with their clients */
    public function findOwnedBy(User $user): array
    {
        /** @var list<OAuthConsent> */
        return $this->createQueryBuilder('c')
            ->addSelect('client')
            ->join('c.client', 'client')
            ->where('c.user = :user')
            ->setParameter('user', $user->getId(), 'uuid')
            ->orderBy('c.createdAt', 'DESC')
            ->addOrderBy('c.id', 'DESC')
            ->getQuery()
            ->getResult();
    }

    /**
     * Returns the consent only when it is the user's own, so other users' apps look like they do not exist.
     */
    public function findOneOwnedBy(User $user, string $id): ?OAuthConsent
    {
        if (!Uuid::isValid($id)) {
            return null;
        }

        return $this->findOneBy(['id' => Uuid::fromString($id), 'user' => $user]);
    }
}
