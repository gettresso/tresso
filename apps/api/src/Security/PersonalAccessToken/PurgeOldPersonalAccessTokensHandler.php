<?php

declare(strict_types=1);

namespace App\Security\PersonalAccessToken;

use Doctrine\DBAL\Connection;
use Psr\Clock\ClockInterface;
use Symfony\Component\Messenger\Attribute\AsMessageHandler;

/**
 * Revoked and expired tokens stay in the list for a while, so the user sees what stopped working; after that they go.
 */
#[AsMessageHandler]
final readonly class PurgeOldPersonalAccessTokensHandler
{
    public const string KEEP_FOR = 'P30D';

    public function __construct(
        private Connection $connection,
        private ClockInterface $clock,
    ) {
    }

    public function __invoke(PurgeOldPersonalAccessTokens $message): int
    {
        $before = $this->clock->now()->sub(new \DateInterval(self::KEEP_FOR))->format('Y-m-d H:i:s');

        return (int) $this->connection->executeStatement(
            'DELETE FROM personal_access_token WHERE revoked_at < :before OR expires_at < :before',
            ['before' => $before],
        );
    }
}
