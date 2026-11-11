<?php

declare(strict_types=1);

namespace App\Sync\Ingest;

use App\Entity\MailAccount;
use App\Entity\Message;
use App\Entity\Thread;
use App\HandOver\HandOvers;
use App\Mail\SubjectNormalizer;
use Doctrine\ORM\EntityManagerInterface;

/**
 * Finds the conversation a new message belongs to.
 *
 * 1. Headers, both directions: threads of messages it refers to (In-Reply-To, References), and threads of messages
 *    that refer to it (a reply that arrived first). When that matches several threads, they are one conversation
 *    and are merged.
 * 2. Without any references: a recent thread with the same normalized subject that shares a counterpart, someone
 *    other than the user: one of its messages is from them, or is the user's own mail to them. The user's own
 *    addresses do not count, since they are on nearly every message; otherwise every mail would join any conversation
 *    with the same subject the user once wrote in. Nor does a recipient two strangers share (an alias, billing@, a
 *    colleague in Cc): only the user's own mail counts by whom it went to. This covers clients that do not send References, without joining unrelated
 *    mails that happen to share a subject.
 * 3. Otherwise a new thread.
 */
final readonly class Threader
{
    private const string SUBJECT_WINDOW = 'P14D';
    private const int SUBJECT_CANDIDATES = 5;

    public function __construct(
        private EntityManagerInterface $entityManager,
        private HandOvers $handOvers,
    )
    {
    }

    /**
     * @param list<string> $referencedIds normalized Message-IDs this message refers to
     * @param list<string> $counterparts  lowercased from, to and cc addresses without the user's own addresses
     * @param list<string> $ownAddresses  the addresses of all the user's accounts, lowercased
     */
    public function threadFor(MailAccount $account, ?string $messageId, array $referencedIds, string $subject, array $counterparts, array $ownAddresses, \DateTimeImmutable $receivedAt): Thread
    {
        $threads = $this->threadsByHeaders($account, $messageId, $referencedIds);

        if ([] !== $threads) {
            $target = array_shift($threads);
            foreach ($threads as $other) {
                $this->merge($target, $other);
            }

            return $target;
        }

        if ([] === $referencedIds) {
            $bySubject = $this->threadBySubject($account, $subject, $counterparts, $ownAddresses, $receivedAt);
            if (null !== $bySubject) {
                return $bySubject;
            }
        }

        $thread = new Thread($account, $subject, $receivedAt);
        $this->entityManager->persist($thread);

        return $thread;
    }

    /**
     * @param list<string> $referencedIds
     *
     * @return list<Thread> oldest first
     */
    private function threadsByHeaders(MailAccount $account, ?string $messageId, array $referencedIds): array
    {
        $byId = [];

        if ([] !== $referencedIds) {
            /** @var list<Thread> $parents */
            $parents = $this->entityManager->createQuery(
                'SELECT t FROM App\Entity\Thread t WHERE t.id IN (
                    SELECT IDENTITY(m.thread) FROM App\Entity\Message m
                    WHERE m.mailAccount = :account AND m.messageIdHeader IN (:ids)
                )',
            )->setParameter('account', $account->getId(), 'uuid')->setParameter('ids', $referencedIds)->getResult();
            foreach ($parents as $thread) {
                $byId[$thread->getId()->toRfc4122()] = $thread;
            }
        }

        if (null !== $messageId) {
            /** @var list<Thread> $children */
            $children = $this->entityManager->createQuery(
                'SELECT t FROM App\Entity\Thread t WHERE t.id IN (
                    SELECT IDENTITY(m.thread) FROM App\Entity\MessageReference r JOIN r.message m
                    WHERE r.mailAccount = :account AND r.referencedMessageId = :id
                )',
            )->setParameter('account', $account->getId(), 'uuid')->setParameter('id', $messageId)->getResult();
            foreach ($children as $thread) {
                $byId[$thread->getId()->toRfc4122()] = $thread;
            }
        }

        // UUIDv7 ids sort by creation time, so the oldest thread survives a merge.
        ksort($byId);

        return array_values($byId);
    }

    /**
     * @param list<string> $counterparts
     * @param list<string> $ownAddresses
     */
    private function threadBySubject(MailAccount $account, string $subject, array $counterparts, array $ownAddresses, \DateTimeImmutable $receivedAt): ?Thread
    {
        $normalized = SubjectNormalizer::normalize($subject);
        if ('' === $normalized || [] === $counterparts) {
            return null;
        }

        $window = new \DateInterval(self::SUBJECT_WINDOW);
        /** @var list<Thread> $candidates */
        $candidates = $this->entityManager->createQuery(
            'SELECT t FROM App\Entity\Thread t
             WHERE t.mailAccount = :account AND t.normalizedSubject = :subject AND t.lastMessageAt BETWEEN :from AND :until
             ORDER BY t.lastMessageAt DESC',
        )
            ->setParameter('account', $account->getId(), 'uuid')
            ->setParameter('subject', $normalized)
            ->setParameter('from', $receivedAt->sub($window))
            ->setParameter('until', $receivedAt->add($window))
            ->setMaxResults(self::SUBJECT_CANDIDATES)
            ->getResult();

        $connection = $this->entityManager->getConnection();
        $addresses = self::textArray($counterparts);
        $own = self::textArray($ownAddresses);
        foreach ($candidates as $thread) {
            // From a counterpart, or the user's own mail to one (to or cc). Whom someone else wrote to says nothing.
            $shared = $connection->fetchOne(
                "SELECT 1 FROM message m
                 WHERE m.thread_id = :thread
                   AND (m.from_address = ANY(CAST(:addresses AS TEXT[]))
                     OR (m.from_address = ANY(CAST(:own AS TEXT[])) AND (
                         EXISTS (
                             SELECT 1 FROM json_array_elements(CASE WHEN json_typeof(m.recipients->'to') = 'array' THEN m.recipients->'to' ELSE '[]'::json END) r
                             WHERE lower(r->>'address') = ANY(CAST(:addresses AS TEXT[]))
                         )
                         OR EXISTS (
                             SELECT 1 FROM json_array_elements(CASE WHEN json_typeof(m.recipients->'cc') = 'array' THEN m.recipients->'cc' ELSE '[]'::json END) r
                             WHERE lower(r->>'address') = ANY(CAST(:addresses AS TEXT[]))
                         )
                     )))
                 LIMIT 1",
                ['thread' => $thread->getId()->toRfc4122(), 'addresses' => $addresses, 'own' => $own],
            );

            if (false !== $shared) {
                return $thread;
            }
        }

        return null;
    }

    private function merge(Thread $target, Thread $other): void
    {
        /** @var list<Message> $messages */
        $messages = $this->entityManager->getRepository(Message::class)->findBy(['thread' => $other]);
        foreach ($messages as $message) {
            $message->moveToThread($target);
            $target->recordMessage($message->getReceivedAt());
        }
        $this->handOvers->threadsMerged($other, $target);
        // The survivor is the oldest conversation; where the user put the other one counts as much.
        $target->adoptUserPlacement($other);
        $this->entityManager->remove($other);
    }

    /** @param list<string> $values */
    private static function textArray(array $values): string
    {
        return '{'.implode(',', array_map(static fn (string $value): string => '"'.addcslashes($value, '"\\').'"', $values)).'}';
    }
}
