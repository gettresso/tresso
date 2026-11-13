<?php

declare(strict_types=1);

namespace App\Repository;

use App\Entity\MeetingPreferences;
use App\Entity\User;
use Doctrine\Bundle\DoctrineBundle\Repository\ServiceEntityRepository;
use Doctrine\DBAL\LockMode;
use Doctrine\DBAL\Types\Types;
use Doctrine\ORM\Query;
use Doctrine\Persistence\ManagerRegistry;

/**
 * @extends ServiceEntityRepository<MeetingPreferences>
 */
class MeetingPreferencesRepository extends ServiceEntityRepository
{
    public function __construct(ManagerRegistry $registry)
    {
        parent::__construct($registry, MeetingPreferences::class);
    }

    /**
     * The user's preferences, or the defaults (not persisted) when they never changed them.
     */
    public function forUser(User $user): MeetingPreferences
    {
        return $this->findOneBy(['user' => $user]) ?? new MeetingPreferences($user);
    }

    /**
     * The user's preferences to change, locked until the transaction ends and read as they are then. The row is created
     * with the defaults when missing, and two first changes at the same moment both find the one row instead of both
     * creating it.
     */
    public function lockForUser(User $user): MeetingPreferences
    {
        $defaults = new MeetingPreferences($user);
        $this->getEntityManager()->getConnection()->executeStatement(
            'INSERT INTO meeting_preferences (user_id, own_link, add_with_guests, defaults, default_other, disabled, updated_at)
             VALUES (:user, NULL, :addWithGuests, :defaults, NULL, :disabled, :updated) ON CONFLICT (user_id) DO NOTHING',
            [
                'user' => $user->getId()->toRfc4122(),
                'addWithGuests' => $defaults->addsWithGuests(),
                'defaults' => '{}',
                'disabled' => '[]',
                'updated' => $defaults->getUpdatedAt(),
            ],
            ['addWithGuests' => Types::BOOLEAN, 'updated' => Types::DATETIME_IMMUTABLE],
        );

        // Refreshed: this request may have loaded the row before another request changed it and released the lock.
        /** @var MeetingPreferences */
        return $this->createQueryBuilder('p')
            ->where('p.user = :user')
            ->setParameter('user', $user->getId(), 'uuid')
            ->getQuery()
            ->setLockMode(LockMode::PESSIMISTIC_WRITE)
            ->setHint(Query::HINT_REFRESH, true)
            ->getSingleResult();
    }
}
