<?php

declare(strict_types=1);

namespace App\Chat;

use App\Enum\ChatOutgoingStatus;
use App\Sync\Change\ChangeSequencer;
use Doctrine\DBAL\Connection;
use Symfony\Component\Uid\Uuid;

/**
 * Hands the oldest waiting reply of an account to its relay, once. In SQL on one connection, so two claims can be
 * raced on two connections in a test.
 *
 * The owner's row is locked first ({@see ChatOwnerLock}), as by every chat write: two claims of one account (or a claim
 * and an import, a cancel or the sweep) take turns, and the second sees the reply the first took as `sending`. Every
 * writer of replies holds that lock, so no reply row can be locked by another transaction here and a SKIP LOCKED would
 * never skip: there is none.
 */
final readonly class ChatClaims
{
    public function __construct(
        private Connection $connection,
        private ChangeSequencer $sequencer,
        private ChatOwnerLock $ownerLock,
    ) {
    }

    /**
     * The reply now `sending`, claimed at $now by $deviceId: its id and the claim's token, which only the claiming relay
     * gets and its result must name. Null when none waits. Inside a transaction.
     *
     * @return array{id: string, token: string}|null
     */
    public function claim(Uuid $owner, Uuid $accountId, Uuid $deviceId, \DateTimeImmutable $now): ?array
    {
        $this->ownerLock->lock($owner);
        $id = $this->connection->fetchOne(
            'SELECT id FROM chat_outgoing WHERE chat_account_id = :account AND status = :waiting ORDER BY id LIMIT 1',
            ['account' => $accountId->toRfc4122(), 'waiting' => ChatOutgoingStatus::Waiting->value],
        );
        if (!\is_string($id)) {
            return null;
        }
        $token = bin2hex(random_bytes(16));
        $this->connection->executeStatement(
            'UPDATE chat_outgoing SET status = :sending, claimed_at = :now, claimed_by = :device, claim_token = :token, change_seq = :seq WHERE id = :id',
            [
                'sending' => ChatOutgoingStatus::Sending->value,
                'now' => ChatTime::stored($now)->format('Y-m-d H:i:s'),
                'device' => $deviceId->toRfc4122(),
                'token' => $token,
                'seq' => $this->sequencer->next($owner),
                'id' => $id,
            ],
        );

        return ['id' => $id, 'token' => $token];
    }
}
