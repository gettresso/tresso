<?php

declare(strict_types=1);

namespace App\Sync\Ingest;

use App\Batch\BatchDelivery;
use App\Entity\MailAccount;
use App\Entity\Message;
use App\Entity\Thread;
use App\Enum\FolderRole;
use App\HandOver\HandOvers;
use App\Mail\SubjectNormalizer;
use Doctrine\ORM\EntityManagerInterface;
use Symfony\Component\Uid\Uuid;

/**
 * Finds the conversation a new message belongs to.
 *
 * 1. Headers, both directions: threads of messages it refers to (In-Reply-To, References), and threads of messages
 *    that refer to it (a reply that arrived first). When that matches several threads, they are one conversation
 *    and are merged.
 * 2. Without any references: the newest thread of the last 14 days with the same normalized subject in which one of
 *    the people who matter took part. Mail is the user's own when it is from one of their account addresses or filed
 *    in a Sent folder (that also covers an alias they send from elsewhere, which Tresso knows nothing else about).
 *    - Someone else's mail joins a thread with someone else's mail from one of its own people (its sender, or whom it
 *      went to: a reply-all of a colleague), or with the user's own mail that went to its sender (a reply).
 *    - The user's own mail joins a thread with someone else's mail from one of its To recipients (an answer), or
 *      with the user's own mail that went to every one of its To recipients (writing again to the same people). Its
 *      Cc says nothing, not even when that colleague wrote in the other conversation.
 *    The user's addresses never count, as they are on nearly every message, and neither does a recipient that only
 *    happens to be shared (an alias or billing@ two strangers wrote to, a colleague the user copies on everything).
 *    The price: a reply without References from a new address that only copies the original recipient (Bob answers
 *    for Anna, Cc Anna) starts its own thread.
 * 3. Otherwise a new thread.
 */
final readonly class Threader
{
    private const string SUBJECT_WINDOW = 'P14D';

    public function __construct(
        private EntityManagerInterface $entityManager,
        private HandOvers $handOvers,
        private BatchDelivery $batches,
    )
    {
    }

    /**
     * @param list<string> $referencedIds normalized Message-IDs this message refers to
     * @param list<string> $counterparts  lowercased addresses of the people the message is about, other than the user:
     *                                    sender, to and cc of someone else's mail; the To of the user's own mail
     * @param list<string> $needed        who an older own message must have gone to: the sender of someone else's
     *                                    mail, or every To recipient of the user's own mail
     * @param list<string> $ownAddresses  the addresses of all the user's accounts, lowercased
     */
    public function threadFor(MailAccount $account, ?string $messageId, array $referencedIds, string $subject, array $counterparts, array $needed, array $ownAddresses, \DateTimeImmutable $receivedAt): Thread
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
            $bySubject = $this->threadBySubject($account, $subject, $counterparts, $needed, $ownAddresses, $receivedAt);
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
     * One query: the candidates and the people condition together, newest first, so an older thread of the right
     * people is found however many newer ones of others share its subject. It starts from the thread index on
     * (mail_account_id, normalized_subject) and looks into each candidate through message (thread_id).
     *
     * @param list<string> $counterparts
     * @param list<string> $needed
     * @param list<string> $ownAddresses
     */
    private function threadBySubject(MailAccount $account, string $subject, array $counterparts, array $needed, array $ownAddresses, \DateTimeImmutable $receivedAt): ?Thread
    {
        $normalized = SubjectNormalizer::normalize($subject);
        if ('' === $normalized || ([] === $counterparts && [] === $needed)) {
            return null;
        }

        $window = new \DateInterval(self::SUBJECT_WINDOW);
        $recipients = "SELECT lower(r->>'address') FROM json_array_elements(CASE WHEN json_typeof(m.recipients->'%1\$s') = 'array' THEN m.recipients->'%1\$s' ELSE '[]'::json END) r";
        // Own mail: from an account address, or filed in one of this account's Sent folders (by id, so the check stays
        // a lookup of the message's own locations, never a scan of every Sent folder).
        $connection = $this->entityManager->getConnection();
        /** @var list<string> $sentFolders */
        $sentFolders = $connection->fetchFirstColumn(
            'SELECT id FROM folder WHERE mail_account_id = :account AND role = :sent',
            ['account' => $account->getId()->toRfc4122(), 'sent' => FolderRole::Sent->value],
        );
        $own = "(m.from_address = ANY(CAST(:own AS TEXT[]))
                 OR EXISTS (SELECT 1 FROM message_location l WHERE l.message_id = m.id AND l.folder_id = ANY(CAST(:sentFolders AS UUID[]))))";
        $threadId = $connection->fetchOne(
            \sprintf(
                "SELECT t.id FROM thread t
                 WHERE t.mail_account_id = :account AND t.normalized_subject = :subject AND t.last_message_at BETWEEN :from AND :until
                   AND EXISTS (
                       SELECT 1 FROM message m
                       WHERE m.thread_id = t.id
                         AND ((NOT %1\$s AND m.from_address = ANY(CAST(:counterparts AS TEXT[])))
                           OR (cardinality(CAST(:needed AS TEXT[])) > 0 AND %1\$s
                               AND CAST(:needed AS TEXT[]) <@ ARRAY(%2\$s UNION ALL %3\$s)))
                   )
                 ORDER BY t.last_message_at DESC, t.id DESC
                 LIMIT 1",
                $own,
                \sprintf($recipients, 'to'),
                \sprintf($recipients, 'cc'),
            ),
            [
                'account' => $account->getId()->toRfc4122(),
                'subject' => $normalized,
                'from' => $receivedAt->sub($window)->format('Y-m-d H:i:s'),
                'until' => $receivedAt->add($window)->format('Y-m-d H:i:s'),
                'own' => self::textArray($ownAddresses),
                'sentFolders' => '{'.implode(',', $sentFolders).'}',
                'counterparts' => self::textArray($counterparts),
                'needed' => self::textArray($needed),
            ],
        );

        return \is_string($threadId) ? $this->entityManager->find(Thread::class, Uuid::fromString($threadId)) : null;
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
        $delivered = $target->adoptUserPlacement($other);
        $this->entityManager->remove($other);
        if ($delivered) {
            // Visible as the user left it: none of its messages waits for a batch (and notifies) later.
            $this->entityManager->flush();
            $this->batches->releaseThread($target);
        }
    }

    /** @param list<string> $values */
    private static function textArray(array $values): string
    {
        return '{'.implode(',', array_map(static fn (string $value): string => '"'.addcslashes($value, '"\\').'"', $values)).'}';
    }
}
