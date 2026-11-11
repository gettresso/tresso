<?php

declare(strict_types=1);

namespace App\Notification;

use App\Entity\User;
use Doctrine\DBAL\Connection;
use Symfony\Contracts\Service\ResetInterface;

/**
 * Where a user may have email notifications sent: their sign-in address, and the address of each Google or Microsoft
 * account whose address the provider confirmed (the account's address equals the one of its provider grant, which
 * comes from the provider's sign-in).
 *
 * An IMAP account never counts, synced or not. Its address is only what was typed in, next to a username, a password
 * and servers chosen by the same person: a sync proves that someone can log in to that server, and a server of one's
 * own accepts any username, so neither the sync nor a username equal to the address shows that the address is theirs.
 * Tresso has no confirmed send-as addresses to go by either.
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
            'SELECT a.email_address FROM mail_account a JOIN provider_grant g ON g.id = a.provider_grant_id
             WHERE a.owner_id = :owner AND g.owner_id = :owner AND LOWER(a.email_address) = LOWER(g.email_address)',
            ['owner' => $key],
        );

        return $this->cache[$key] = array_values(array_unique(array_map(mb_strtolower(...), [$user->getEmail(), ...$accounts])));
    }

    public function reset(): void
    {
        $this->cache = [];
    }
}
