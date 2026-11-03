<?php

declare(strict_types=1);

namespace App\Security\OAuth;

use Doctrine\DBAL\Connection;
use Psr\Clock\ClockInterface;
use Symfony\Component\Messenger\Attribute\AsMessageHandler;

/**
 * Anyone can register a client, and many registrations are never finished (the user closes the consent screen, or an
 * app registers again on every start). A registered client that has not got a single token 30 days after registering,
 * and that no user allowed, is deleted with everything the database keeps for it. Only registered clients are
 * considered: our own apps and clients made by hand have no registered_client row.
 */
#[AsMessageHandler]
final readonly class PurgeUnusedRegisteredClientsHandler
{
    public const string KEEP_FOR = 'P30D';

    public function __construct(
        private Connection $connection,
        private ClockInterface $clock,
    ) {
    }

    public function __invoke(PurgeUnusedRegisteredClients $message): int
    {
        $before = $this->clock->now()->sub(new \DateInterval(self::KEEP_FOR))->format('Y-m-d H:i:s');

        return (int) $this->connection->executeStatement(
            'DELETE FROM oauth2_client WHERE identifier IN (SELECT r.client_id FROM registered_client r WHERE r.last_used_at IS NULL AND r.created_at < :before AND NOT EXISTS (SELECT 1 FROM oauth_consent c WHERE c.client_id = r.client_id))',
            ['before' => $before],
        );
    }
}
