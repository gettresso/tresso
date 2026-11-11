<?php

declare(strict_types=1);

namespace App\Classification;

use App\Batch\BatchDelivery;
use App\Entity\Category;
use App\Entity\Message;
use App\Entity\Thread;
use App\Entity\User;
use App\Enum\FolderRole;
use App\Enum\Verdict;
use App\Mail\MessageFields;
use App\Notification\MailNotifier;
use App\Repository\CategoryRepository;
use App\Repository\MailAccountRepository;
use App\Repository\SenderRuleRepository;
use App\Todo\EmailTodos;
use Doctrine\DBAL\Connection;
use Doctrine\ORM\EntityManagerInterface;
use Symfony\Component\Uid\Uuid;

/**
 * Runs the {@see Classifier} over a user's mail and stores the outcome: on each incoming message and on its
 * conversation, which takes the smart inbox and verdict of its newest incoming message. The user's own messages are
 * never classified. Conversations the user put in a smart inbox themselves keep it. New mail in a smart inbox that
 * asks for todos gets one (see {@see EmailTodos::makeAutomatically()}), and new mail is handed to the
 * {@see MailNotifier}, in the same transaction; classifying again later makes no todo and never notifies. New mail of a smart inbox that delivers in batches is held for the next batch (see
 * {@see BatchDelivery}) and notifies once its batch delivers it.
 *
 * Work goes in batches, each in its own transaction, so change numbers commit in order and a crash loses at most one
 * batch, which the next run picks up again. Runs for one user take turns on an advisory lock, so two runs never
 * classify the same message at once.
 */
final readonly class MailClassification
{
    private const int BATCH_SIZE = 200;

    /**
     * The message is filed as sent: in Sent or Drafts, and otherwise only in folders that hold everything (Gmail's All
     * Mail, an IMAP All or Archive folder). It is the user's own, also when sent from an address that is not one of
     * their accounts (an alias).
     */
    private const string FILED_AS_SENT = "(EXISTS (SELECT 1 FROM message_location l JOIN folder f ON f.id = l.folder_id WHERE l.message_id = m.id AND f.role IN ('sent', 'drafts'))
        AND NOT EXISTS (SELECT 1 FROM message_location l JOIN folder f ON f.id = l.folder_id WHERE l.message_id = m.id AND f.role NOT IN ('sent', 'drafts', 'all', 'archive')))";

    public function __construct(
        private EntityManagerInterface $entityManager,
        private Connection $connection,
        private Classifier $classifier,
        private BuiltinSmartInboxes $builtinSmartInboxes,
        private CategoryRepository $smartInboxes,
        private SenderRuleRepository $senderRules,
        private MailAccountRepository $accounts,
        private UserLocks $locks,
        private EmailTodos $emailTodos,
        private MailNotifier $mailNotifier,
        private BatchDelivery $batches,
        private MessageFields $fields,
    ) {
    }

    /**
     * Classifies the messages of the user that were not looked at yet, at most $maxBatches batches (all when null).
     *
     * @return bool whether messages are left for another run
     */
    public function classifyNew(Uuid $userId, ?int $maxBatches = null): bool
    {
        for ($batch = 0; null === $maxBatches || $batch < $maxBatches; ++$batch) {
            $count = $this->entityManager->wrapInTransaction(fn (): int => $this->classifyNewBatch($userId));
            $this->entityManager->clear();
            if ($count < self::BATCH_SIZE) {
                return false;
            }
        }

        return true;
    }

    /**
     * Classifies the user's conversations again: those with mail since $since (every one when null), and those that
     * lost their smart inbox; only those with mail from $sender (an address or `@domain`) when given. Conversations
     * the user placed themselves are left alone. Runs at most $maxBatches batches (all when null) from thread id
     * $after on.
     *
     * @return string|null the thread id to go on after, or null when done
     */
    public function reclassify(Uuid $userId, ?\DateTimeImmutable $since, ?string $sender = null, ?string $after = null, ?int $maxBatches = null): ?string
    {
        $after ??= '00000000-0000-0000-0000-000000000000';
        for ($batch = 0; null === $maxBatches || $batch < $maxBatches; ++$batch) {
            $threadIds = $this->entityManager->wrapInTransaction(fn (): array => $this->reclassifyBatch($userId, $since, $sender, $after));
            $this->entityManager->clear();
            if (\count($threadIds) < self::BATCH_SIZE) {
                return null;
            }
            $after = $threadIds[\count($threadIds) - 1];
        }

        return $after;
    }

    private function classifyNewBatch(Uuid $userId): int
    {
        $this->lock($userId);
        $user = $this->entityManager->find(User::class, $userId);
        if (null === $user) {
            return 0;
        }

        /** @var list<string> $messageIds */
        $messageIds = $this->connection->fetchFirstColumn(
            'SELECT m.id FROM message m JOIN mail_account a ON a.id = m.mail_account_id
             WHERE a.owner_id = :user AND m.classified_at IS NULL
             ORDER BY m.received_at, m.id LIMIT :limit',
            ['user' => $userId->toRfc4122(), 'limit' => self::BATCH_SIZE],
        );
        if ([] === $messageIds) {
            return 0;
        }

        $context = $this->context($user);
        $now = new \DateTimeImmutable();
        $messages = $this->incomingMessages($messageIds, $context);
        $batchTimes = $this->batches->times($user);

        /** @var array<string, Classification> $byMessage */
        $byMessage = [];
        foreach ($this->mailToClassify($messages) as $id => $mail) {
            $classification = $this->classifier->classify($mail, $context);
            $message = $messages[$id];
            $message->classify($classification->smartInbox, $classification->verdict, $now);
            // New mail of a smart inbox that delivers in batches waits for the next batch, unless the user placed the
            // conversation themselves: it then stays where they put it and its mail arrives as it comes.
            if (!$message->getThread()->isClassifiedByUser()) {
                $this->batches->holdNew($message, $classification->smartInbox, $batchTimes, $now);
            }
            $byMessage[$id] = $classification;
        }
        $this->entityManager->flush();
        $new = array_values(array_intersect_key($messages, $byMessage));
        $this->emailTodos->makeAutomatically($user, $new, $now);
        $this->mailNotifier->consider($user, $new, $now);

        // A conversation follows its newest incoming message, if that is one classified just now.
        $threads = [];
        foreach ($messages as $message) {
            $threads[$message->getThread()->getId()->toRfc4122()] = $message->getThread();
        }
        $newest = $this->newestIncomingIds(array_keys($threads), $context);
        foreach ($threads as $threadId => $thread) {
            $messageId = $newest[$threadId] ?? null;
            if (null !== $messageId && isset($byMessage[$messageId]) && !$thread->isClassifiedByUser()) {
                $classification = $byMessage[$messageId];
                $thread->classify($classification->smartInbox, $classification->verdict, $classification->reason, $now);
                $thread->followDelivery($messages[$messageId]);
            }
        }
        $this->entityManager->flush();

        // The user's own messages are only marked as looked at; not a change clients see.
        $this->connection->executeStatement(
            'UPDATE message SET classified_at = :now WHERE id = ANY(CAST(:ids AS UUID[])) AND classified_at IS NULL',
            ['now' => $now->format('Y-m-d H:i:s'), 'ids' => '{'.implode(',', $messageIds).'}'],
        );

        return \count($messageIds);
    }

    /**
     * @return list<string> the thread ids of the batch, in id order
     */
    private function reclassifyBatch(Uuid $userId, ?\DateTimeImmutable $since, ?string $sender, string $after): array
    {
        $this->lock($userId);
        $user = $this->entityManager->find(User::class, $userId);
        if (null === $user) {
            return [];
        }

        /** @var list<string> $threadIds */
        $threadIds = $this->connection->fetchFirstColumn(
            "SELECT t.id FROM thread t JOIN mail_account a ON a.id = t.mail_account_id
             WHERE a.owner_id = :user AND t.id > :after
               AND (t.classification_reason IS NULL OR t.classification_reason <> :byUser)
               AND (CAST(:since AS TIMESTAMP) IS NULL OR t.last_message_at >= CAST(:since AS TIMESTAMP)
                    OR (t.category_id IS NULL AND t.classified_at IS NOT NULL))
               AND (CAST(:address AS TEXT) IS NULL OR EXISTS (
                    SELECT 1 FROM message m WHERE m.thread_id = t.id
                      AND (m.from_address = :address OR m.from_address LIKE :domain OR m.from_address LIKE :subdomain)))
             ORDER BY t.id LIMIT :limit",
            [
                'user' => $userId->toRfc4122(),
                'after' => $after,
                'byUser' => ClassificationReason::USER,
                'since' => $since?->format('Y-m-d H:i:s'),
                ...self::senderParameters($sender),
                'limit' => self::BATCH_SIZE,
            ],
        );
        if ([] === $threadIds) {
            return [];
        }

        $context = $this->context($user);
        $now = new \DateTimeImmutable();
        $newest = $this->newestIncomingIds($threadIds, $context);
        $messages = $this->incomingMessages(array_values($newest), $context);
        foreach ($this->mailToClassify($messages) as $id => $mail) {
            $classification = $this->classifier->classify($mail, $context);
            $message = $messages[$id];
            $message->classify($classification->smartInbox, $classification->verdict, $now);
            $this->batches->moved($message, $classification->smartInbox);
            $message->getThread()->classify($classification->smartInbox, $classification->verdict, $classification->reason, $now);
            $message->getThread()->followDelivery($message);
        }
        $this->entityManager->flush();

        return $threadIds;
    }

    /** The newest message of the conversation someone else sent; null when it has only the user's own mail. */
    public function newestIncoming(Thread $thread): ?Message
    {
        $context = new ClassificationContext($this->ownAddresses($thread->getMailAccount()->getOwner()), [], []);
        $messageId = $this->newestIncomingIds([$thread->getId()->toRfc4122()], $context)[$thread->getId()->toRfc4122()] ?? null;

        return null === $messageId ? null : $this->entityManager->find(Message::class, Uuid::fromString($messageId));
    }

    /**
     * Why mail like this message goes to Spam whatever the user remembers for its sender (see
     * {@see RuleBasedClassifier::spamOverrulingRules()}): `authentication_failed`, `server_spam`, or null.
     */
    public function spamOverrulingRules(Message $message, Category $spam): ?string
    {
        $mail = $this->mailToClassify([$message->getId()->toRfc4122() => $message])[$message->getId()->toRfc4122()] ?? null;

        return null === $mail ? null : RuleBasedClassifier::spamOverrulingRules($mail, $spam);
    }

    /**
     * Applies the user's choice to a conversation: it moves to the smart inbox with the verdict, now and for good, and
     * so does its newest incoming message (see {@see newestIncoming()}). Returns the placement's id. The caller holds
     * the user's locks (see {@see UserLocks}) and loaded the thread and the smart inbox after taking them.
     */
    public function placeByUser(Thread $thread, ?Message $newestIncoming, Category $smartInbox, Verdict $verdict): Uuid
    {
        $now = new \DateTimeImmutable();
        $placementId = $thread->placeByUser($smartInbox, $verdict, $now);
        $newestIncoming?->classify($smartInbox, $verdict, $now);
        // The user is looking at it: whatever batch its mail waited for, all of it is delivered now.
        $this->batches->releaseThread($thread);

        return $placementId;
    }

    /**
     * Lets the rules place a conversation the user placed themselves again, as if they never had: the conversation and
     * its newest incoming message go where the classifier puts that message now, and a conversation with only the
     * user's own mail is no longer in any smart inbox. The caller holds the user's locks (see {@see UserLocks}) and
     * loaded the thread after taking them.
     *
     * @return Message|null the message placed, or null when the conversation has only the user's own mail
     */
    public function placeByRules(Thread $thread): ?Message
    {
        $context = $this->context($thread->getMailAccount()->getOwner());
        $threadId = $thread->getId()->toRfc4122();
        $messageId = $this->newestIncomingIds([$threadId], $context)[$threadId] ?? null;
        if (null === $messageId) {
            $thread->unclassify();

            return null;
        }
        $messages = $this->incomingMessages([$messageId], $context);
        $mail = $this->mailToClassify($messages)[$messageId] ?? null;
        if (null === $mail) {
            $thread->unclassify();

            return null;
        }

        $classification = $this->classifier->classify($mail, $context);
        $now = new \DateTimeImmutable();
        $messages[$messageId]->classify($classification->smartInbox, $classification->verdict, $now);
        $thread->classify($classification->smartInbox, $classification->verdict, $classification->reason, $now);

        return $messages[$messageId];
    }

    /**
     * Matches the From address against a sender pattern in SQL: an address exactly, a domain with its subdomains, and
     * everything when there is no pattern (address null).
     *
     * @return array{address: ?string, domain: ?string, subdomain: ?string}
     */
    private static function senderParameters(?string $sender): array
    {
        if (null === $sender) {
            return ['address' => null, 'domain' => null, 'subdomain' => null];
        }
        $sender = SenderPattern::normalize($sender);
        if (!SenderPattern::isDomain($sender)) {
            return ['address' => $sender, 'domain' => null, 'subdomain' => null];
        }
        $domain = addcslashes(substr($sender, 1), '%_\\');

        return ['address' => $sender, 'domain' => '%@'.$domain, 'subdomain' => '%.'.$domain];
    }

    private function lock(Uuid $userId): void
    {
        $this->locks->classification($userId);
    }

    private function context(User $user): ClassificationContext
    {
        if ([] !== $this->builtinSmartInboxes->ensure($user)) {
            $this->entityManager->flush();
        }
        $this->builtinSmartInboxes->syncOlder($user);

        return new ClassificationContext($this->ownAddresses($user), $this->smartInboxes->findOwnedBy($user), $this->senderRules->findOwnedBy($user));
    }

    /** @return list<string> */
    private function ownAddresses(User $user): array
    {
        $addresses = [];
        foreach ($this->accounts->findOwnedBy($user) as $account) {
            $addresses[] = mb_strtolower($account->getEmailAddress());
        }

        return $addresses;
    }

    /**
     * The newest message of each thread that someone else sent.
     *
     * @param list<string> $threadIds
     *
     * @return array<string, string> thread id to message id
     */
    private function newestIncomingIds(array $threadIds, ClassificationContext $context): array
    {
        if ([] === $threadIds) {
            return [];
        }

        /** @var list<array{thread_id: string, id: string}> $rows */
        $rows = $this->connection->fetchAllAssociative(
            'SELECT DISTINCT ON (m.thread_id) m.thread_id, m.id FROM message m
             WHERE m.thread_id = ANY(CAST(:threads AS UUID[])) AND NOT (m.from_address = ANY(CAST(:own AS TEXT[])))
               AND NOT '.self::FILED_AS_SENT.'
             ORDER BY m.thread_id, m.received_at DESC, m.id DESC',
            ['threads' => '{'.implode(',', $threadIds).'}', 'own' => self::textArray($context->ownAddresses())],
        );

        return array_column($rows, 'id', 'thread_id');
    }

    /**
     * The given messages that someone else sent, loaded as entities.
     *
     * @param list<string> $messageIds
     *
     * @return array<string, Message> by id
     */
    private function incomingMessages(array $messageIds, ClassificationContext $context): array
    {
        if ([] === $messageIds) {
            return [];
        }

        /** @var list<Message> $messages */
        $messages = $this->entityManager->getRepository(Message::class)->findBy(['id' => array_map(Uuid::fromString(...), $messageIds)]);
        $incoming = [];
        foreach ($messages as $message) {
            if (!$context->isOwnAddress($message->getFromAddress())) {
                $incoming[$message->getId()->toRfc4122()] = $message;
            }
        }

        return $incoming;
    }

    /**
     * @param array<string, Message> $messages
     *
     * @return array<string, MailToClassify> by message id
     */
    private function mailToClassify(array $messages): array
    {
        if ([] === $messages) {
            return [];
        }

        /** @var list<array{id: string, headers: ?string, junk: bool|null, roles: string}> $rows */
        $rows = $this->connection->fetchAllAssociative(
            "SELECT m.id, s.headers, s.junk,
                    COALESCE((SELECT json_agg(f.role) FROM message_location l JOIN folder f ON f.id = l.folder_id WHERE l.message_id = m.id), '[]') AS roles
             FROM message m LEFT JOIN message_signals s ON s.message_id = m.id
             WHERE m.id = ANY(CAST(:ids AS UUID[]))",
            ['ids' => '{'.implode(',', array_keys($messages)).'}'],
        );
        $extra = array_column($rows, null, 'id');

        $result = [];
        foreach ($messages as $id => $message) {
            $row = $extra[$id] ?? ['headers' => null, 'junk' => false, 'roles' => '[]'];
            /** @var array<string, string> $headers */
            $headers = null === $row['headers'] ? [] : json_decode($row['headers'], true, flags: \JSON_THROW_ON_ERROR);
            /** @var list<string> $roles */
            $roles = json_decode($row['roles'], true, flags: \JSON_THROW_ON_ERROR);
            $folderRoles = array_values(array_filter(array_map(FolderRole::tryFrom(...), $roles)));
            if (self::filedAsSent($folderRoles)) {
                // The user's own, from an address Tresso does not know as theirs.
                continue;
            }
            $recipients = $message->getRecipients();

            $result[$id] = new MailToClassify(
                $id,
                $message->getFromAddress(),
                $message->getFromName(),
                array_map(static fn (array $a): string => mb_strtolower($a['address']), $recipients['to'] ?? []),
                array_map(static fn (array $a): string => mb_strtolower($a['address']), $recipients['cc'] ?? []),
                $message->getSubject(),
                $this->fields->snippet($message),
                $headers,
                (bool) $row['junk'],
                $folderRoles,
                null !== $message->getInReplyTo(),
                ReceivingServers::wroteResults($message->getMailAccount()->getProvider(), $headers['authentication-results'] ?? null),
            );
        }

        return $result;
    }

    /**
     * Mirrors {@see FILED_AS_SENT}.
     *
     * @param list<FolderRole> $roles
     */
    private static function filedAsSent(array $roles): bool
    {
        $sent = array_filter($roles, static fn (FolderRole $role): bool => FolderRole::Sent === $role || FolderRole::Drafts === $role);
        $elsewhere = array_filter($roles, static fn (FolderRole $role): bool => !\in_array($role, [FolderRole::Sent, FolderRole::Drafts, FolderRole::All, FolderRole::Archive], true));

        return [] !== $sent && [] === $elsewhere;
    }

    /** @param list<string> $values */
    private static function textArray(array $values): string
    {
        return '{'.implode(',', array_map(static fn (string $v): string => '"'.addcslashes($v, '"\\').'"', $values)).'}';
    }
}
