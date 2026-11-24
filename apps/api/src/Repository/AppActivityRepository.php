<?php

declare(strict_types=1);

namespace App\Repository;

use App\Activity\ActivityApp;
use App\Activity\ActivityCursor;
use App\Activity\ActivityKind;
use App\Activity\ActivityResult;
use App\Entity\AppActivity;
use App\Entity\User;
use Doctrine\Bundle\DoctrineBundle\Repository\ServiceEntityRepository;
use Doctrine\Persistence\ManagerRegistry;

/**
 * @extends ServiceEntityRepository<AppActivity>
 */
class AppActivityRepository extends ServiceEntityRepository
{
    public function __construct(ManagerRegistry $registry)
    {
        parent::__construct($registry, AppActivity::class);
    }

    /**
     * The owner's entries since $since, newest first, after the cursor, filtered; one more than $limit, so the caller
     * knows whether there is a next page.
     *
     * @return list<AppActivity>
     */
    public function findPage(User $owner, \DateTimeImmutable $since, ?ActivityApp $app, ?ActivityKind $kind, ?ActivityResult $result, ?ActivityCursor $cursor, int $limit): array
    {
        $query = $this->createQueryBuilder('a')
            ->where('a.owner = :owner')
            ->andWhere('a.occurredAt >= :since')
            ->setParameter('owner', $owner->getId(), 'uuid')
            ->setParameter('since', $since)
            ->orderBy('a.occurredAt', 'DESC')
            ->addOrderBy('a.id', 'DESC')
            ->setMaxResults($limit + 1);
        if (null !== $app) {
            $query->andWhere('a.appType = :appType')->andWhere('a.appId = :appId')
                ->setParameter('appType', $app->type)
                ->setParameter('appId', $app->id);
        }
        if (null !== $kind) {
            $query->andWhere('a.kind = :kind')->setParameter('kind', $kind->value);
        }
        if (null !== $result) {
            $query->andWhere('a.result = :result')->setParameter('result', $result->value);
        }
        if (null !== $cursor) {
            $query->andWhere('a.occurredAt < :at OR (a.occurredAt = :at AND a.id < :id)')
                ->setParameter('at', $cursor->at)
                ->setParameter('id', $cursor->id, 'uuid');
        }

        /** @var list<AppActivity> */
        return $query->getQuery()->getResult();
    }

    /**
     * Every app the owner has entries of.
     *
     * @return list<ActivityApp>
     */
    public function findApps(User $owner): array
    {
        /** @var list<array{appType: string, appId: string}> $rows */
        $rows = $this->createQueryBuilder('a')
            ->select('DISTINCT a.appType, a.appId')
            ->where('a.owner = :owner')
            ->setParameter('owner', $owner->getId(), 'uuid')
            ->getQuery()
            ->getArrayResult();

        return array_map(
            static fn (array $row): ActivityApp => ActivityApp::TOKEN === $row['appType'] ? ActivityApp::token($row['appId']) : ActivityApp::client(rtrim($row['appId'])),
            $rows,
        );
    }
}
