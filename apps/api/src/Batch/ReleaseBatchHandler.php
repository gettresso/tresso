<?php

declare(strict_types=1);

namespace App\Batch;

use Doctrine\ORM\EntityManagerInterface;
use Doctrine\Persistence\ManagerRegistry;
use Psr\Log\LoggerInterface;
use Symfony\Component\Messenger\Attribute\AsMessageHandler;
use Symfony\Component\Uid\Uuid;

final readonly class ReleaseBatchHandler
{
    /** Users a sweep releases; the rest wait for the next minute. */
    public const int SWEEP_USERS = 200;

    public function __construct(
        private EntityManagerInterface $entityManager,
        private BatchDelivery $batches,
        private ManagerRegistry $managers,
        private LoggerInterface $logger,
    ) {
    }

    #[AsMessageHandler]
    public function release(ReleaseBatch $message): void
    {
        if (Uuid::isValid($message->userId)) {
            $this->releaseUser(Uuid::fromString($message->userId));
        }
    }

    #[AsMessageHandler]
    public function sweep(SweepBatches $message): void
    {
        // One user whose release fails (a deadlock, a planning error) must not hold up everyone after them, the more so
        // as they stay the longest overdue and so come first again next time.
        foreach ($this->batches->usersWithDueMail(new \DateTimeImmutable(), self::SWEEP_USERS) as $userId) {
            try {
                $this->releaseUser(Uuid::fromString($userId));
            } catch (\Throwable $e) {
                $this->logger->error('Releasing a batch failed', ['user' => $userId, 'error' => $e->getMessage()]);
                if ($this->entityManager->isOpen()) {
                    $this->entityManager->clear();
                } else {
                    $this->managers->resetManager();
                }
            }
        }
    }

    /** Each part in its own transaction, so change numbers commit in order and a large batch holds no lock for long. */
    private function releaseUser(Uuid $userId): void
    {
        do {
            $more = $this->entityManager->wrapInTransaction(fn (): bool => $this->batches->releaseDue($userId, new \DateTimeImmutable()));
            $this->entityManager->clear();
        } while ($more);
    }
}
