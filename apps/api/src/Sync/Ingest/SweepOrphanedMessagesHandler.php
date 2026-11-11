<?php

declare(strict_types=1);

namespace App\Sync\Ingest;

use App\Entity\MailAccount;
use Doctrine\ORM\EntityManagerInterface;
use Doctrine\Persistence\ManagerRegistry;
use Psr\Clock\ClockInterface;
use Psr\Log\LoggerInterface;
use Symfony\Component\Messenger\Attribute\AsMessageHandler;
use Symfony\Component\Uid\Uuid;

/**
 * Deletes the messages whose copy did not show up in another folder within {@see MessageJanitor::GRACE}, account by
 * account, each in its own transaction, until its time budget is used up; the next run continues. An account that
 * fails is logged and skipped, so it never keeps the others' orphans around.
 */
#[AsMessageHandler]
final readonly class SweepOrphanedMessagesHandler
{
    private const int ACCOUNTS = 100;
    private const int PER_ACCOUNT = 5000;
    private const float BUDGET_SECONDS = 20.0;

    public function __construct(
        private EntityManagerInterface $entityManager,
        private MessageJanitor $janitor,
        private ManagerRegistry $managers,
        private ClockInterface $clock,
        private LoggerInterface $logger,
    ) {
    }

    public function __invoke(SweepOrphanedMessages $message): void
    {
        $started = microtime(true);
        $before = $this->clock->now()->sub(new \DateInterval(MessageJanitor::GRACE));
        $skip = [];

        do {
            /** @var list<string> $accounts */
            $accounts = $this->entityManager->getConnection()->fetchFirstColumn(
                'SELECT DISTINCT mail_account_id FROM message WHERE orphaned_at < :before AND NOT (mail_account_id = ANY(CAST(:skip AS UUID[]))) LIMIT :limit',
                ['before' => $before->setTimezone(new \DateTimeZone('UTC'))->format('Y-m-d H:i:s'), 'skip' => '{'.implode(',', array_keys($skip)).'}', 'limit' => self::ACCOUNTS],
            );
            foreach ($accounts as $accountId) {
                // An account with more than its share comes back in the next round of this loop; one that is done or
                // failed does not.
                if ($this->sweepAccount($accountId, $before) < self::PER_ACCOUNT) {
                    $skip[$accountId] = true;
                }
                if (microtime(true) - $started >= self::BUDGET_SECONDS) {
                    return;
                }
            }
        } while ([] !== $accounts);
    }

    /**
     * @return int the number of deleted messages (0 when it failed)
     */
    private function sweepAccount(string $accountId, \DateTimeImmutable $before): int
    {
        try {
            $deleted = $this->entityManager->wrapInTransaction(function () use ($accountId, $before): int {
                $account = $this->entityManager->find(MailAccount::class, Uuid::fromString($accountId));

                return null === $account ? 0 : $this->janitor->removeExpiredOrphans($account, $before, self::PER_ACCOUNT);
            });
            $this->entityManager->clear();

            return $deleted;
        } catch (\Throwable $e) {
            $this->logger->error('Deleting messages that are in no folder anymore failed.', ['account' => $accountId, 'error' => $e->getMessage()]);
            $this->managers->resetManager();

            return 0;
        }
    }
}
