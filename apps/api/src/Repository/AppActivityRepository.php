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
use Doctrine\ORM\Query\ResultSetMappingBuilder;
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
     * knows whether there is a next page. The cursor is a row comparison, `(occurred_at, id) < (:at, :id)`, which the
     * index on owner, time and id answers as one range.
     *
     * @return list<AppActivity>
     */
    public function findPage(User $owner, \DateTimeImmutable $since, ?ActivityApp $app, ?ActivityKind $kind, ?ActivityResult $result, ?ActivityCursor $cursor, int $limit): array
    {
        $mapping = new ResultSetMappingBuilder($this->getEntityManager());
        $mapping->addRootEntityFromClassMetadata(AppActivity::class, 'a');
        $where = ['a.owner_id = :owner', 'a.occurred_at >= :since'];
        $parameters = ['owner' => $owner->getId()->toRfc4122(), 'since' => $since->format('Y-m-d H:i:s')];
        if (null !== $app) {
            $where[] = 'a.app_type = :appType AND a.app_id = :appId';
            $parameters += ['appType' => $app->type, 'appId' => $app->id];
        }
        if (null !== $kind) {
            $where[] = 'a.kind = :kind';
            $parameters['kind'] = $kind->value;
        }
        if (null !== $result) {
            $where[] = 'a.result = :result';
            $parameters['result'] = $result->value;
        }
        if (null !== $cursor) {
            $where[] = '(a.occurred_at, a.id) < (CAST(:at AS TIMESTAMP), CAST(:id AS UUID))';
            $parameters += ['at' => $cursor->at->format('Y-m-d H:i:s'), 'id' => $cursor->id->toRfc4122()];
        }

        $query = $this->getEntityManager()->createNativeQuery(
            'SELECT '.$mapping->generateSelectClause().' FROM app_activity a WHERE '.implode(' AND ', $where).' ORDER BY a.occurred_at DESC, a.id DESC LIMIT '.($limit + 1),
            $mapping,
        );
        foreach ($parameters as $name => $value) {
            $query->setParameter($name, $value);
        }

        /** @var list<AppActivity> */
        return $query->getResult();
    }

    /**
     * The apps for the log's app filter: those the owner has connected or made a token for now, and those with entries
     * since $since, read from the small per-day table (one row per app and day) rather than from the log.
     *
     * @return list<ActivityApp>
     */
    public function findApps(User $owner, \DateTimeImmutable $since): array
    {
        $connection = $this->getEntityManager()->getConnection();
        $owner = $owner->getId()->toRfc4122();
        $rows = $connection->fetchAllAssociative(
            "SELECT DISTINCT app_type, TRIM(app_id) AS app_id FROM app_activity_day WHERE owner_id = :owner AND day >= :since
             UNION SELECT 'client', TRIM(client_id) FROM oauth_consent WHERE user_id = :owner
             UNION SELECT 'token', CAST(id AS VARCHAR) FROM personal_access_token WHERE owner_id = :owner AND revoked_at IS NULL",
            ['owner' => $owner, 'since' => $since->format('Y-m-d')],
        );

        $apps = [];
        foreach ($rows as $row) {
            $type = \is_string($row['app_type']) ? $row['app_type'] : '';
            $id = \is_string($row['app_id']) ? $row['app_id'] : '';
            $app = ActivityApp::fromKey($type.':'.$id);
            if (null !== $app) {
                $apps[$app->key()] = $app;
            }
        }

        return array_values($apps);
    }

    /** Whether the owner's log holds nothing at all (in the last 90 days, all it keeps). */
    public function isEmpty(User $owner): bool
    {
        return false === $this->getEntityManager()->getConnection()->fetchOne(
            'SELECT 1 FROM app_activity_day WHERE owner_id = :owner LIMIT 1',
            ['owner' => $owner->getId()->toRfc4122()],
        );
    }
}
