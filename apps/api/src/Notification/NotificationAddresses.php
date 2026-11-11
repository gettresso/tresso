<?php

declare(strict_types=1);

namespace App\Notification;

use App\Entity\User;
use Doctrine\DBAL\Connection;
use Symfony\Contracts\Service\ResetInterface;

/**
 * Where a user may have email notifications sent: their sign-in address, and the address of each mail account they
 * proved to hold. A Google or Microsoft account was signed in with at the provider; an IMAP account counts once it
 * synced, since then the user has working credentials for that mailbox. The address of an IMAP account that never
 * synced is only what was typed in, so it could be anyone's.
 */
final class NotificationAddresses implements ResetInterface
{
    /** @var array<string, list<string>> */
    private array $cache = [];

    public function __construct(private readonly Connection $connection)
    {
    }

    /**
     * @return list<string> lower case
     */
    public function of(User $user): array
    {
        $key = $user->getId()->toRfc4122();
        if (isset($this->cache[$key])) {
            return $this->cache[$key];
        }

        /** @var list<string> $accounts */
        $accounts = $this->connection->fetchFirstColumn(
            'SELECT email_address FROM mail_account WHERE owner_id = :owner AND (provider_grant_id IS NOT NULL OR last_synced_at IS NOT NULL)',
            ['owner' => $key],
        );

        return $this->cache[$key] = array_values(array_unique(array_map(mb_strtolower(...), [$user->getEmail(), ...$accounts])));
    }

    public function reset(): void
    {
        $this->cache = [];
    }
}
