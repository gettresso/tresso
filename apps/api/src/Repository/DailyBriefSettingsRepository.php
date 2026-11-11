<?php

declare(strict_types=1);

namespace App\Repository;

use App\Brief\BriefTime;
use App\Entity\DailyBriefSettings;
use App\Entity\NotificationPreferences;
use App\Entity\User;
use Doctrine\DBAL\ParameterType;
use Doctrine\Bundle\DoctrineBundle\Repository\ServiceEntityRepository;
use Doctrine\Persistence\ManagerRegistry;
use Symfony\Component\Uid\Uuid;

/**
 * @extends ServiceEntityRepository<DailyBriefSettings>
 */
class DailyBriefSettingsRepository extends ServiceEntityRepository
{
    /** Users the backfill gives settings per batch. */
    public const int BACKFILL_BATCH = 500;

    public function __construct(ManagerRegistry $registry)
    {
        parent::__construct($registry, DailyBriefSettings::class);
    }

    public function findOneFor(User $user): ?DailyBriefSettings
    {
        return $this->find($user->getId());
    }

    /**
     * Claims one user whose brief is due: the row stays locked until the transaction ends, and other sweeps skip it.
     * Must run inside a transaction.
     */
    public function claimDue(\DateTimeImmutable $now): ?Uuid
    {
        $id = $this->getEntityManager()->getConnection()->fetchOne(
            'SELECT user_id FROM daily_brief_settings WHERE enabled = true AND next_run_at <= :now ORDER BY next_run_at LIMIT 1 FOR UPDATE SKIP LOCKED',
            ['now' => $now->setTimezone(new \DateTimeZone('UTC'))->format('Y-m-d H:i:s')],
        );

        return \is_string($id) ? Uuid::fromString($id) : null;
    }

    /**
     * Puts a user's next brief off, after their run failed; outside any transaction, so it holds once written. The
     * moment it was due is kept (the first time only), so the brief keeps its day ({@see DailyBriefSettings::postpone()}).
     */
    public function postpone(Uuid $userId, \DateTimeImmutable $until): void
    {
        $this->getEntityManager()->getConnection()->executeStatement(
            'UPDATE daily_brief_settings SET due_at = COALESCE(due_at, next_run_at), next_run_at = :until WHERE user_id = :user',
            ['until' => $until->setTimezone(new \DateTimeZone('UTC'))->format('Y-m-d H:i:s'), 'user' => $userId->toRfc4122()],
        );
    }

    /**
     * Gives users made before daily briefs existed the default settings (on, at the default time in their notification
     * zone): the given user, or up to $limit users that have none. A user who got settings in the meantime keeps them,
     * so this is safe beside every other writer.
     *
     * @return int how many users without settings were found (at most $limit); some may have got theirs meanwhile
     */
    public function createMissing(\DateTimeImmutable $now, ?User $user = null, int $limit = self::BACKFILL_BATCH): int
    {
        $connection = $this->getEntityManager()->getConnection();
        /** @var list<array{id: string, time_zone: ?string}> $missing */
        $missing = $connection->fetchAllAssociative(
            'SELECT u.id, p.time_zone FROM app_user u LEFT JOIN notification_preferences p ON p.user_id = u.id
             WHERE (CAST(:user AS UUID) IS NULL OR u.id = CAST(:user AS UUID))
               AND NOT EXISTS (SELECT 1 FROM daily_brief_settings s WHERE s.user_id = u.id)
             ORDER BY u.id LIMIT :limit',
            ['user' => $user?->getId()->toRfc4122(), 'limit' => $limit],
            ['limit' => ParameterType::INTEGER],
        );

        foreach ($missing as $row) {
            $zone = $row['time_zone'] ?? NotificationPreferences::DEFAULT_TIME_ZONE;
            $connection->executeStatement(
                'INSERT INTO daily_brief_settings (user_id, enabled, deliver_at, next_run_at, covered_until)
                 VALUES (:user, :enabled, :deliverAt, :nextRunAt, NULL)
                 ON CONFLICT (user_id) DO NOTHING',
                [
                    'user' => $row['id'],
                    'enabled' => DailyBriefSettings::DEFAULT_ENABLED,
                    'deliverAt' => DailyBriefSettings::DEFAULT_DELIVER_AT,
                    'nextRunAt' => BriefTime::nextRun(DailyBriefSettings::DEFAULT_DELIVER_AT, $zone, $now)->format('Y-m-d H:i:s'),
                ],
                ['enabled' => ParameterType::BOOLEAN],
            );
        }

        return \count($missing);
    }
}
