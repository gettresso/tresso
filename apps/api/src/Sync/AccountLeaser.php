<?php

declare(strict_types=1);

namespace App\Sync;

use App\Enum\MailAccountStatus;
use App\Billing\Entitlements;
use Doctrine\DBAL\Connection;
use Doctrine\DBAL\ParameterType;

/**
 * Hands out mail accounts to sync workers.
 *
 * A worker calls lease() periodically as its heartbeat: it renews the leases it already holds and claims expired or
 * unleased accounts up to its capacity. When a worker dies its leases expire and other workers pick them up.
 * SKIP LOCKED lets many workers lease concurrently without blocking each other or double-claiming an account.
 *
 * Lease times come from PHP's clock in UTC, like every other stored time: the database's now() would be in its session
 * time zone, which {@see LeaseGuard} would misread whenever the two zones differ.
 */
final readonly class AccountLeaser
{
    public const int LEASE_SECONDS = 90;

    public function __construct(
        private Connection $connection,
        private Entitlements $entitlements,
    ) {
    }

    /**
     * @return list<array{id: string, emailAddress: string, provider: string, leaseExpiresAt: string}>
     */
    public function lease(string $workerId, int $capacity): array
    {
        $now = new \DateTimeImmutable('now', new \DateTimeZone('UTC'));
        $expires = $now->add(new \DateInterval('PT'.self::LEASE_SECONDS.'S'));

        return $this->connection->transactional(function (Connection $connection) use ($workerId, $capacity, $now, $expires): array {
            /** @var list<array{id: string, email_address: string, provider: string, lease_expires_at: string}> $rows */
            $rows = $connection->fetchAllAssociative(
                \sprintf(<<<'SQL'
                    WITH claimable AS (
                        SELECT id
                        FROM mail_account
                        WHERE status IN (:active, :error)
                          AND (leased_by = :worker OR lease_expires_at IS NULL OR lease_expires_at < CAST(:now AS TIMESTAMP))
                          AND (NOT :billing OR %s)
                        ORDER BY (leased_by = :worker) DESC NULLS LAST, last_synced_at ASC NULLS FIRST
                        LIMIT :capacity
                        FOR UPDATE SKIP LOCKED
                    )
                    UPDATE mail_account AS account
                    SET leased_by = :worker,
                        lease_expires_at = CAST(:expires AS TIMESTAMP)
                    FROM claimable
                    WHERE account.id = claimable.id
                    RETURNING account.id, account.email_address, account.provider, account.lease_expires_at
                    SQL, Entitlements::condition('mail_account.owner_id')),
                [
                    'active' => MailAccountStatus::Active->value,
                    // A sync problem is temporary: such accounts keep being retried. Paused accounts and refused
                    // logins wait for the user.
                    'error' => MailAccountStatus::Error->value,
                    'worker' => $workerId,
                    'capacity' => $capacity,
                    'now' => $now->format('Y-m-d H:i:s'),
                    'expires' => $expires->format('Y-m-d H:i:s'),
                    // On a server that bills, accounts of users without a trial or subscription are not synced.
                    'billing' => $this->entitlements->billingEnabled(),
                    ...$this->entitlements->parameters(),
                ],
                ['billing' => ParameterType::BOOLEAN],
            );

            // Accounts this worker held but no longer got back (paused, deleted, over capacity) are released.
            $leasedIds = array_column($rows, 'id');
            $connection->executeStatement(
                'UPDATE mail_account SET leased_by = NULL, lease_expires_at = NULL WHERE leased_by = :worker AND NOT (id = ANY(:ids::uuid[]))',
                ['worker' => $workerId, 'ids' => '{'.implode(',', $leasedIds).'}'],
            );

            return array_map(static fn (array $row): array => [
                'id' => $row['id'],
                'emailAddress' => $row['email_address'],
                'provider' => $row['provider'],
                'leaseExpiresAt' => new \DateTimeImmutable($row['lease_expires_at'], new \DateTimeZone('UTC'))->format(\DATE_ATOM),
            ], $rows);
        });
    }

    public function release(string $workerId): int
    {
        return (int) $this->connection->executeStatement(
            'UPDATE mail_account SET leased_by = NULL, lease_expires_at = NULL WHERE leased_by = :worker',
            ['worker' => $workerId],
        );
    }
}
