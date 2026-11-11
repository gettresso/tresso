<?php

declare(strict_types=1);

namespace App\Tests\Functional;

use App\Security\Crypto\UserKeys;
use App\Storage\BlobKey;
use App\Storage\BlobKind;
use App\Storage\BlobVault;
use App\Sync\Ingest\MessageJanitor;
use App\Sync\Ingest\SweepOrphanedMessages;
use App\Sync\Ingest\SweepOrphanedMessagesHandler;
use Doctrine\DBAL\Connection;
use Doctrine\ORM\EntityManagerInterface;
use Doctrine\Persistence\ManagerRegistry;
use Psr\Log\NullLogger;
use Symfony\Component\Clock\MockClock;
use Symfony\Component\Uid\Uuid;

/**
 * Names and stores mail content the way the sync worker does: encrypted with the account owner's key, under the
 * owner's id and fingerprint.
 */
trait StoresMail
{
    /** Where the worker stores the raw MIME $content of the account's owner. */
    protected function rawKeyFor(string $accountId, string $content): string
    {
        return BlobKey::of(BlobKind::Raw, $this->accountOwner($accountId), $this->fingerprintFor($accountId, $content));
    }

    /** The account owner's fingerprint of $content, as the worker reports it for an attachment. */
    protected function fingerprintFor(string $accountId, string $content): string
    {
        return static::getContainer()->get(BlobVault::class)->fingerprint($this->accountOwner($accountId), hash('sha256', $content));
    }

    /** Stores $content as the worker does and returns its key. */
    protected function storeAsWorker(string $accountId, BlobKind $kind, string $content): string
    {
        return static::getContainer()->get(BlobVault::class)->store($this->accountOwner($accountId), $kind, $content)->key;
    }

    /** The key version the account owner's new content is encrypted with. */
    protected function keyVersionOf(string $accountId): int
    {
        return static::getContainer()->get(UserKeys::class)->current($this->accountOwner($accountId))->version;
    }

    /**
     * Runs the sweep for messages in no folder as it runs once their grace period is over: messages whose copy did not
     * show up elsewhere meanwhile are deleted.
     */
    protected function sweepOrphanedMessages(string $after = '+16 minutes'): void
    {
        $container = static::getContainer();
        $handler = new SweepOrphanedMessagesHandler(
            $container->get(EntityManagerInterface::class),
            $container->get(MessageJanitor::class),
            $container->get(ManagerRegistry::class),
            new MockClock(new \DateTimeImmutable($after)),
            new NullLogger(),
        );
        $handler(new SweepOrphanedMessages());
    }

    protected function accountOwner(string $accountId): Uuid
    {
        $owner = static::getContainer()->get(Connection::class)->fetchOne('SELECT owner_id FROM mail_account WHERE id = :id', ['id' => $accountId]);
        if (!\is_string($owner)) {
            throw new \LogicException(\sprintf('There is no mail account %s.', $accountId));
        }

        return Uuid::fromString($owner);
    }
}
