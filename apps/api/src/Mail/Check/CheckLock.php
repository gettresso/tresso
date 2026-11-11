<?php

declare(strict_types=1);

namespace App\Mail\Check;

use Doctrine\DBAL\Connection;

/**
 * One connection check per user at a time, across every API instance: a PostgreSQL advisory lock on the user's id,
 * held by this request's database session for the length of the check.
 */
class CheckLock
{
    /** Keeps these locks apart from any other advisory lock of the application. */
    private const int NAMESPACE = 0x6D61696C;

    public function __construct(private readonly Connection $connection)
    {
    }

    /**
     * Runs $check while holding the user's lock.
     *
     * @template T
     *
     * @param \Closure(): T $check
     *
     * @return T|null null when another check of the same user is running
     */
    public function run(string $userId, \Closure $check): mixed
    {
        $key = self::key($userId);
        if (true !== $this->connection->fetchOne('SELECT pg_try_advisory_lock(:namespace, :key)', ['namespace' => self::NAMESPACE, 'key' => $key])) {
            return null;
        }
        try {
            return $check();
        } finally {
            $this->connection->executeStatement('SELECT pg_advisory_unlock(:namespace, :key)', ['namespace' => self::NAMESPACE, 'key' => $key]);
        }
    }

    /** A key for the user that fits the int4 of an advisory lock. */
    public static function key(string $userId): int
    {
        return crc32($userId) & 0x7FFFFFFF;
    }
}
