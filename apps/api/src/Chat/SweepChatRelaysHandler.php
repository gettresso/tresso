<?php

declare(strict_types=1);

namespace App\Chat;

use App\Enum\ChatOutgoingError;
use App\Enum\ChatOutgoingStatus;
use App\Sync\Change\ChangeSequencer;
use Doctrine\DBAL\Connection;
use Psr\Clock\ClockInterface;
use Symfony\Component\Messenger\Attribute\AsMessageHandler;
use Symfony\Component\Uid\Uuid;

/**
 * Runs every minute on the `scheduler_default` transport (the `maintenance` worker), and by hand as
 * `app:chat:sweep-relays`:
 *
 * - A relay not heard from for {@see OFFLINE_AFTER} is offline from the time it was last heard from. Clients then show
 *   "Waiting for your Mac" for replies that wait; the next call of the relay puts it online again
 *   ({@see ChatRelayGuard}). Heartbeats themselves are no change for clients, so only these flips reach the delta.
 * - A reply still `sending` {@see ChatQueue::CLAIM_LEASE} after the relay claimed it is `failed` with `unconfirmed`:
 *   the bridge may have sent it, so it is never handed out again until the user presses Try again.
 *
 * Each owner is handled in a transaction of its own, which takes the owner's row first as every chat write does
 * ({@see ChatOwnerLock}); an owner whose row is busy is skipped and comes back on the next run. Every change gets the
 * owner's next change number, so clients see it.
 */
#[AsMessageHandler]
final readonly class SweepChatRelaysHandler
{
    public const string OFFLINE_AFTER = 'PT3M';

    /** Owners per run; the rest come on the next. */
    private const int LIMIT = 500;

    public function __construct(
        private Connection $connection,
        private ChangeSequencer $sequencer,
        private ChatOwnerLock $ownerLock,
        private ClockInterface $clock,
    ) {
    }

    public function __invoke(SweepChatRelays $message): void
    {
        $this->sweep();
    }

    /**
     * @return array{offline: int, unconfirmed: int} relays marked offline, replies marked unconfirmed
     */
    public function sweep(): array
    {
        $now = $this->clock->now()->setTimezone(new \DateTimeZone(date_default_timezone_get()));
        $silentSince = $now->sub(new \DateInterval(self::OFFLINE_AFTER))->format('Y-m-d H:i:s');
        $claimedBefore = $now->sub(new \DateInterval(ChatQueue::CLAIM_LEASE))->format('Y-m-d H:i:s');

        $owners = $this->connection->fetchFirstColumn(
            'SELECT owner_id FROM (
                SELECT a.owner_id FROM chat_account a WHERE a.relay_online AND a.relay_seen_at < :silent
                UNION
                SELECT a.owner_id FROM chat_account a
                 WHERE EXISTS (SELECT 1 FROM chat_outgoing o WHERE o.chat_account_id = a.id AND o.status = :sending AND o.claimed_at < :claimed)
             ) owners LIMIT :limit',
            ['silent' => $silentSince, 'claimed' => $claimedBefore, 'sending' => ChatOutgoingStatus::Sending->value, 'limit' => self::LIMIT],
        );

        $offline = 0;
        $unconfirmed = 0;
        foreach ($owners as $owner) {
            if (!\is_string($owner)) {
                throw new \UnexpectedValueException('Expected an owner id.');
            }
            [$accounts, $replies] = $this->connection->transactional(fn (): array => $this->sweepOwner(Uuid::fromString($owner), $silentSince, $claimedBefore));
            $offline += $accounts;
            $unconfirmed += $replies;
        }

        return ['offline' => $offline, 'unconfirmed' => $unconfirmed];
    }

    /**
     * @return array{int, int}
     */
    private function sweepOwner(Uuid $owner, string $silentSince, string $claimedBefore): array
    {
        if (!$this->ownerLock->tryLock($owner)) {
            return [0, 0];
        }
        // The conditions are checked again under the lock: a relay heard from meanwhile stays online.
        $accounts = $this->connection->fetchFirstColumn(
            'UPDATE chat_account SET relay_online = false, relay_offline_since = relay_seen_at
              WHERE owner_id = :owner AND relay_online AND relay_seen_at < :silent RETURNING id',
            ['owner' => $owner->toRfc4122(), 'silent' => $silentSince],
        );
        $replies = $this->connection->fetchFirstColumn(
            'UPDATE chat_outgoing o SET status = :failed, error = :unconfirmed FROM chat_account a
              WHERE a.id = o.chat_account_id AND a.owner_id = :owner AND o.status = :sending AND o.claimed_at < :claimed RETURNING o.id',
            [
                'owner' => $owner->toRfc4122(),
                'claimed' => $claimedBefore,
                'failed' => ChatOutgoingStatus::Failed->value,
                'unconfirmed' => ChatOutgoingError::Unconfirmed->value,
                'sending' => ChatOutgoingStatus::Sending->value,
            ],
        );
        if ([] === $accounts && [] === $replies) {
            return [0, 0];
        }

        $seq = $this->sequencer->next($owner);
        $this->touch('chat_account', $accounts, $seq);
        $this->touch('chat_outgoing', $replies, $seq);

        return [\count($accounts), \count($replies)];
    }

    /**
     * @param list<mixed> $ids
     */
    private function touch(string $table, array $ids, int $seq): void
    {
        if ([] === $ids) {
            return;
        }
        $this->connection->executeStatement(
            \sprintf('UPDATE %s SET change_seq = :seq WHERE id = ANY(CAST(:ids AS UUID[]))', $table),
            ['seq' => $seq, 'ids' => '{'.implode(',', array_map(static fn (mixed $id): string => \is_string($id) ? $id : throw new \UnexpectedValueException('Expected an id.'), $ids)).'}'],
        );
    }
}
