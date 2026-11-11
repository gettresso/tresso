<?php

declare(strict_types=1);

namespace App\Sync;

use App\Entity\MailAccount;
use Doctrine\ORM\EntityManagerInterface;
use Symfony\Component\HttpKernel\Exception\BadRequestHttpException;
use Symfony\Component\HttpKernel\Exception\NotFoundHttpException;
use Symfony\Component\Uid\Uuid;

/**
 * A sync worker may only act on accounts it holds an unexpired lease on. Every other case is a 404, so internal
 * endpoints never reveal which accounts exist.
 */
final readonly class LeaseGuard
{
    public const string WORKER_ID_PATTERN = '/^[A-Za-z0-9._:-]{1,120}$/';

    public function __construct(private EntityManagerInterface $entityManager)
    {
    }

    public function leasedAccount(mixed $accountId, mixed $workerId): MailAccount
    {
        if (!\is_string($workerId) || 1 !== preg_match(self::WORKER_ID_PATTERN, $workerId)) {
            throw new BadRequestHttpException('A valid workerId is required.');
        }

        $account = \is_string($accountId) && Uuid::isValid($accountId)
            ? $this->entityManager->find(MailAccount::class, Uuid::fromString($accountId))
            : null;

        $leaseExpiresAt = $account?->getLeaseExpiresAt();
        if (null === $account || $workerId !== $account->getLeasedBy() || null === $leaseExpiresAt || $leaseExpiresAt <= new \DateTimeImmutable('now', new \DateTimeZone('UTC'))) {
            throw new NotFoundHttpException('No account with that id is leased by this worker.');
        }

        return $account;
    }
}
