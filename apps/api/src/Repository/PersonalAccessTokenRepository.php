<?php

declare(strict_types=1);

namespace App\Repository;

use App\Entity\PersonalAccessToken;
use App\Entity\User;
use Doctrine\Bundle\DoctrineBundle\Repository\ServiceEntityRepository;
use Doctrine\Persistence\ManagerRegistry;
use Symfony\Component\Uid\Uuid;

/**
 * @extends ServiceEntityRepository<PersonalAccessToken>
 */
class PersonalAccessTokenRepository extends ServiceEntityRepository
{
    public function __construct(ManagerRegistry $registry)
    {
        parent::__construct($registry, PersonalAccessToken::class);
    }

    /** @return list<PersonalAccessToken> newest first */
    public function findOwnedBy(User $owner): array
    {
        /** @var list<PersonalAccessToken> */
        return $this->createQueryBuilder('t')
            ->where('t.owner = :owner')
            ->setParameter('owner', $owner->getId(), 'uuid')
            ->orderBy('t.createdAt', 'DESC')
            ->addOrderBy('t.id', 'DESC')
            ->getQuery()
            ->getResult();
    }

    /**
     * Returns the token only when it belongs to the owner, so other users' tokens look like they do not exist.
     */
    public function findOneOwnedBy(User $owner, string $id): ?PersonalAccessToken
    {
        if (!Uuid::isValid($id)) {
            return null;
        }

        return $this->findOneBy(['id' => Uuid::fromString($id), 'owner' => $owner]);
    }

    public function findOneByTokenHash(string $tokenHash): ?PersonalAccessToken
    {
        return $this->findOneBy(['tokenHash' => $tokenHash]);
    }
}
