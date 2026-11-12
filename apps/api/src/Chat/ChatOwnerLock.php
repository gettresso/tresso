<?php

declare(strict_types=1);

namespace App\Chat;

use Doctrine\DBAL\Connection;
use Symfony\Component\Uid\Uuid;

/**
 * Every chat write locks its owner's row first, then the chat rows it changes. Change numbers lock the owner's row too
 * ({@see \App\Sync\Change\ChangeSequencer}), so taking it first gives one order for every writer (the relay, a device of
 * the user, the sweep) and two of them never wait on each other in a circle. It also makes the writes of one user take
 * turns, which they would at their change number anyway.
 *
 * The lock is FOR NO KEY UPDATE, not FOR UPDATE: it changes no key of the row, so it leaves the KEY SHARE alone that
 * every uncommitted insert of a row referring to the user holds (a message, a todo, any of the tables with a foreign
 * key to app_user), and those inserts never wait for a chat write. It still serialises with everything that guards the
 * user's change numbers and keys: ChangeSequencer's `UPDATE app_user SET change_seq` takes FOR NO KEY UPDATE itself,
 * UserKeys takes FOR SHARE (lockOwnerShared) and FOR UPDATE (lockOwner), and each of those conflicts with it.
 */
final readonly class ChatOwnerLock
{
    public function __construct(private Connection $connection)
    {
    }

    /** Waits for the owner's row. Inside a transaction only: the lock ends with it. */
    public function lock(Uuid $owner): void
    {
        $this->guard();
        $this->connection->executeQuery('SELECT id FROM app_user WHERE id = :id FOR NO KEY UPDATE', ['id' => $owner->toRfc4122()]);
    }

    /** Takes the owner's row only when nobody holds it: false when somebody does (the sweep comes back later). */
    public function tryLock(Uuid $owner): bool
    {
        $this->guard();

        return false !== $this->connection->fetchOne('SELECT id FROM app_user WHERE id = :id FOR NO KEY UPDATE SKIP LOCKED', ['id' => $owner->toRfc4122()]);
    }

    private function guard(): void
    {
        if (!$this->connection->isTransactionActive()) {
            throw new \LogicException('A chat write locks its owner inside a transaction.');
        }
    }
}
