<?php

declare(strict_types=1);

namespace App\Unsubscribe;

use App\Classification\ReceivingServers;
use App\Classification\SenderAuthentication;
use App\Entity\MailAccount;
use App\Entity\Message;
use App\Entity\MessageSignals;
use App\Entity\OutgoingMessage;
use App\Entity\Unsubscription;
use App\Enum\BuiltinCategory;
use App\Enum\OutgoingStatus;
use App\Enum\UnsubscribeMethod;
use App\Enum\UnsubscribeStatus;
use App\Outbox\Composition;
use App\Outbox\Outbox;
use App\Realtime\RealtimeNotifier;
use Doctrine\DBAL\LockMode;
use Doctrine\ORM\EntityManagerInterface;

/**
 * One-click unsubscribe. The user asks from a message; a one-click request (RFC 8058) is POSTed by the worker that
 * leases the account (claimed and reported like mailbox changes, announced on the outbox topic), a mailto request is
 * sent as a mail through the outbox and is done once that mail went out. Every method runs inside the caller's
 * transaction.
 */
final readonly class Unsubscriptions
{
    public const string CLAIM_TTL = 'PT5M';
    public const int CLAIM_BATCH = 10;
    /** Waits before attempts 2, 3, ...: one minute up to three hours. */
    private const array RETRY_DELAYS = ['PT1M', 'PT5M', 'PT15M', 'PT1H', 'PT3H'];

    public function __construct(
        private EntityManagerInterface $entityManager,
        private Outbox $outbox,
        private RealtimeNotifier $notifier,
    ) {
    }

    /**
     * Unsubscribes the account that received $message from its sender. Asking again while a request is pending or
     * done changes nothing; after a failure it tries again, with the address of this message. Only an authenticated
     * sender is answered (see {@see UnsubscribeLink}), so a forged message never creates the record that would hide
     * the button for the real sender.
     *
     * @throws UnsubscribeRefused when the message offers no one-click address or should not be answered
     */
    public function request(Message $message, \DateTimeImmutable $now): Unsubscription
    {
        $smartInbox = $message->getCategory() ?? $message->getThread()->getCategory();
        if (BuiltinCategory::Spam === $smartInbox?->getBuiltin()) {
            // Answering spam only tells the spammer the address is read.
            throw new UnsubscribeRefused('Mail in Spam is not unsubscribed from: that would tell the sender your address is read.');
        }
        $account = $message->getMailAccount();
        $headers = $this->entityManager->find(MessageSignals::class, $message->getId())?->getHeaders() ?? [];
        $trusted = ReceivingServers::wroteResults($account->getProvider(), $headers['authentication-results'] ?? null);
        if (!SenderAuthentication::dmarcPassed($headers['authentication-results'] ?? null, $trusted)) {
            throw new UnsubscribeRefused('Tresso only unsubscribes from senders your mail server confirmed, and it did not confirm this one.');
        }
        $link = UnsubscribeLink::fromMessage($headers, $message->getFromAddress(), $trusted);
        if (null === $link) {
            throw new UnsubscribeRefused('This message offers no one-click unsubscribe.');
        }

        // Two requests for one sender take turns, so the second finds the first instead of failing on the unique key.
        $this->entityManager->getConnection()->executeStatement(
            'SELECT pg_advisory_xact_lock(hashtextextended(:key, 0))',
            ['key' => 'unsubscribe:'.$account->getId()->toRfc4122().':'.$message->getFromAddress()],
        );
        $unsubscription = $this->entityManager->getRepository(Unsubscription::class)->findOneBy(['mailAccount' => $account, 'sender' => $message->getFromAddress()]);
        if (null !== $unsubscription) {
            $this->entityManager->refresh($unsubscription, LockMode::PESSIMISTIC_WRITE);
            if (UnsubscribeStatus::Failed !== $unsubscription->getStatus()) {
                return $unsubscription;
            }
            $unsubscription->retry($message, $link->method, $link->uri, $now);
        } else {
            $unsubscription = new Unsubscription($account, $message->getFromAddress(), $message, $link->method, $link->uri, $now);
            $this->entityManager->persist($unsubscription);
        }
        $this->entityManager->flush();

        if (UnsubscribeMethod::Mailto === $link->method) {
            $recipient = $link->recipient ?? throw new \LogicException('A mailto unsubscribe has a recipient.');
            $outgoing = $this->outbox->queue(new Composition(
                $account,
                [['address' => $recipient, 'name' => null]],
                [],
                [],
                UnsubscribeLink::MAIL_TEXT,
                '<p>'.UnsubscribeLink::MAIL_TEXT.'</p>',
                null,
                $now,
            ), $now);
            $unsubscription->sentAs($outgoing);
            $this->entityManager->flush();
        } else {
            $this->notifier->outboxDue($account->getId());
        }

        return $unsubscription;
    }

    /**
     * Takes the account's one-click requests that are due; nobody else makes them while the claim lasts.
     *
     * @return list<Unsubscription>
     */
    public function claim(MailAccount $account, string $workerId, \DateTimeImmutable $now): array
    {
        /** @var list<Unsubscription> $due */
        $due = $this->entityManager->createQueryBuilder()
            ->select('u')->from(Unsubscription::class, 'u')
            ->where('u.mailAccount = :account')
            ->andWhere('u.status = :pending')->andWhere('u.method = :oneClick')
            ->andWhere('u.notBefore <= :now')
            ->andWhere('u.claimedUntil IS NULL OR u.claimedUntil < :now')
            ->setParameter('account', $account->getId(), 'uuid')
            ->setParameter('pending', UnsubscribeStatus::Pending)
            ->setParameter('oneClick', UnsubscribeMethod::OneClick)
            ->setParameter('now', $now)
            ->orderBy('u.notBefore')->addOrderBy('u.id')
            ->setMaxResults(self::CLAIM_BATCH)
            ->getQuery()
            ->setLockMode(LockMode::PESSIMISTIC_WRITE)
            ->getResult();
        $until = $now->add(new \DateInterval(self::CLAIM_TTL));
        foreach ($due as $unsubscription) {
            $unsubscription->claim($workerId, $until);
        }
        $this->entityManager->flush();

        return $due;
    }

    public function reportDone(Unsubscription $unsubscription, \DateTimeImmutable $now): void
    {
        $unsubscription->done($now);
        $this->entityManager->flush();
    }

    public function reportFailed(Unsubscription $unsubscription, string $error, \DateTimeImmutable $now): void
    {
        $unsubscription->fail($error, $now);
        $this->entityManager->flush();
    }

    public function reportRetry(Unsubscription $unsubscription, string $error, \DateTimeImmutable $now): void
    {
        $delay = self::RETRY_DELAYS[min($unsubscription->getAttempts(), \count(self::RETRY_DELAYS) - 1)];
        $unsubscription->retryAt($now->add(new \DateInterval($delay)), $error, $now);
        $this->entityManager->flush();
    }

    /** A mailto request follows its mail: done once sent, failed when it failed or was cancelled. */
    public function outgoingSettled(OutgoingMessage $outgoing, \DateTimeImmutable $now): void
    {
        $unsubscription = $this->entityManager->getRepository(Unsubscription::class)->findOneBy(['outgoingMessage' => $outgoing]);
        if (null === $unsubscription || UnsubscribeStatus::Pending !== $unsubscription->getStatus()) {
            return;
        }
        match ($outgoing->getStatus()) {
            OutgoingStatus::Sent => $unsubscription->done($now),
            OutgoingStatus::Failed => $unsubscription->fail($outgoing->getLastError() ?? 'The unsubscribe mail could not be sent.', $now),
            OutgoingStatus::Cancelled => $unsubscription->fail('The unsubscribe mail was cancelled.', $now),
            default => null,
        };
        $this->entityManager->flush();
    }

    /**
     * Of these accounts, those with one-click requests to make now.
     *
     * @param list<string> $accountIds
     *
     * @return list<string>
     */
    public function accountsWithDueRequests(array $accountIds, \DateTimeImmutable $now): array
    {
        if ([] === $accountIds) {
            return [];
        }

        /** @var list<string> */
        return $this->entityManager->getConnection()->fetchFirstColumn(
            "SELECT DISTINCT mail_account_id FROM unsubscription
             WHERE mail_account_id = ANY(CAST(:ids AS UUID[])) AND status = 'pending' AND method = 'oneClick'
               AND not_before <= :now AND (claimed_until IS NULL OR claimed_until < :now)",
            ['ids' => '{'.implode(',', $accountIds).'}', 'now' => $now->format('Y-m-d H:i:s')],
        );
    }
}
