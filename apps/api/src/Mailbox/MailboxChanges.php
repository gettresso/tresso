<?php

declare(strict_types=1);

namespace App\Mailbox;

use App\Entity\Folder;
use App\Entity\MailAccount;
use App\Entity\MailboxChange;
use App\Entity\Message;
use App\Entity\MessageLocation;
use App\Enum\MailboxChangeKind;
use App\Repository\MailboxChangeRepository;
use App\Sync\Ingest\MessageJanitor;
use Doctrine\ORM\EntityManagerInterface;
use Psr\Log\LoggerInterface;
use Symfony\Component\Uid\Uuid;
use Symfony\Component\Uid\UuidV7;

/**
 * The worker's side of {@see MailboxChange}: it takes the changes it can make now, oldest first, and reports each.
 * A change the server refuses (or that keeps failing) is undone here, so Tresso shows the message as the server has
 * it. Every method runs inside the caller's transaction.
 */
final readonly class MailboxChanges
{
    public const string CLAIM_TTL = 'PT5M';
    public const int CLAIM_BATCH = 100;
    /** Attempts before a change that keeps failing is given up and undone. */
    public const int MAX_ATTEMPTS = 6;
    /**
     * How long a placeholder copy may wait for its move to land once that move is done. The folder sync normally finds
     * the copy within minutes; one that is still missing after this was moved on or deleted elsewhere.
     */
    public const string PLACEHOLDER_TTL = 'PT1H';
    /** Wait before the next attempt, by attempts made so far. */
    private const array BACKOFF = ['PT30S', 'PT2M', 'PT10M', 'PT30M', 'PT2H'];

    public function __construct(
        private EntityManagerInterface $entityManager,
        private MailboxChangeRepository $changes,
        private MessageJanitor $janitor,
        private LoggerInterface $logger,
    ) {
    }

    /**
     * The changes the worker can make now, in the order the user made them. A message's later changes wait while an
     * earlier one cannot be made yet: it is waiting for a retry, claimed, a flag change on a copy that is still being
     * moved, or a move of such a copy. Changes that wait never keep other messages' changes from being taken.
     *
     * @return list<MailboxChange>
     */
    public function claim(MailAccount $account, string $workerId, \DateTimeImmutable $now): array
    {
        // Copies that never showed up are gone for good; a move undone because its folder went may still show up.
        $expired = $this->expirePlaceholders($account, $now);
        $undone = [];

        $until = $now->add(new \DateInterval(self::CLAIM_TTL));
        $claimed = [];
        $waiting = $this->changes->messagesWithChangesInProgress($account, $now);
        $after = null;
        while (\count($claimed) < self::CLAIM_BATCH) {
            $page = $this->changes->lockAvailable($account, $now, $after, self::CLAIM_BATCH);
            if ([] === $page) {
                break;
            }
            foreach ($page as $change) {
                $after = $change->getId();
                $messageId = $change->getMessage()->getId()->toRfc4122();
                if (isset($waiting[$messageId])) {
                    continue;
                }
                if (MailboxChangeKind::Move === $change->getKind() && (null === $change->getSourceFolder() || null === $change->getTargetFolder())) {
                    $this->undo($change, 'The folder is gone from the server.');
                    $undone[] = $messageId;
                    continue;
                }
                if (!$this->canMakeNow($change)) {
                    $waiting[$messageId] = true;
                    continue;
                }
                $change->claim($workerId, $until);
                $claimed[] = $change;
                if (\count($claimed) >= self::CLAIM_BATCH) {
                    break;
                }
            }
        }
        $this->entityManager->flush();
        $this->janitor->removeOrphans($account, $expired);
        $this->janitor->markOrphans($account, $undone, $now);

        return $claimed;
    }

    /**
     * The copies a flag change applies to, as they are on the server: every copy Tresso knows there, plus the copies
     * later moves will take elsewhere (the flags go on before they move, so they travel along).
     *
     * @return list<array{folder: string, uidValidity: ?int, remoteUid: string}>
     */
    public function locations(MailboxChange $change): array
    {
        $locations = [];
        foreach ($this->entityManager->getRepository(MessageLocation::class)->findBy(['message' => $change->getMessage()]) as $location) {
            if (!$location->isPlaceholder()) {
                $locations[] = ['folder' => $location->getFolder()->getRemoteName(), 'uidValidity' => $location->getFolder()->getUidValidity(), 'remoteUid' => $location->getRemoteUid()];
            }
        }
        foreach ($this->pendingMoves($change) as $move) {
            $source = $move->getSourceFolder();
            if (null !== $source && !self::isPlaceholderUid($move->getSourceRemoteUid())) {
                $locations[] = ['folder' => $source->getRemoteName(), 'uidValidity' => $move->getSourceUidValidity(), 'remoteUid' => (string) $move->getSourceRemoteUid()];
            }
        }

        return $locations;
    }

    /**
     * The server made the change. For a move, $remoteUid is the copy's uid in the target folder when the worker learnt
     * it; otherwise the folder sync finds the copy later.
     */
    public function done(MailboxChange $change, ?string $remoteUid): void
    {
        if (MailboxChangeKind::Move === $change->getKind()) {
            $placeholder = $this->placeholder($change);
            if (null === $remoteUid) {
                $this->awaitLanding($change, $placeholder);
            } elseif (null !== $placeholder) {
                $this->land($placeholder, $remoteUid, null);
            } else {
                // The user moved the copy on before it landed: that move can go ahead from here.
                $this->sourceLanded($change->placeholderUid(), $remoteUid, $change->getTargetFolder()?->getUidValidity());
            }
        }
        $this->entityManager->remove($change);
        $this->entityManager->flush();
    }

    /**
     * The copy a move was to take is no longer in its folder: it was moved or deleted on the server already (by this
     * move in an attempt that never got reported, by Gmail taking every label away with the first copy that went to
     * Trash, or by another mail app). Nothing is put back; the folder sync shows the copy wherever it is now. When
     * the placeholder is the message's only copy in Tresso, it stays until then (or until it expires), so the message
     * keeps its identity instead of being deleted and found again.
     */
    public function gone(MailboxChange $change): void
    {
        if (MailboxChangeKind::Move !== $change->getKind()) {
            throw new \LogicException('Only a move can find its copy gone.');
        }
        // Later moves of the copy stay: the folder sync finds it where it went (see arrived()), or they expire.
        $placeholder = $this->placeholder($change);
        $copies = $this->entityManager->getRepository(MessageLocation::class)->findBy(['message' => $change->getMessage()]);
        if (null !== $placeholder && \count($copies) > 1) {
            $this->entityManager->remove($placeholder);
        }
        $this->awaitLanding($change, null !== $placeholder && \count($copies) <= 1 ? $placeholder : null);
        $this->entityManager->remove($change);
        $this->entityManager->flush();
    }

    public function failed(MailboxChange $change, string $workerId, string $error, bool $permanent, \DateTimeImmutable $now): void
    {
        if ($permanent || $change->getAttempts() + 1 >= self::MAX_ATTEMPTS) {
            $messageId = $change->getMessage()->getId()->toRfc4122();
            $this->undo($change, $error);
            $this->entityManager->flush();
            // A move that could not be put back (its folder was reset) leaves the message waiting for its copy.
            $this->janitor->markOrphans($change->getMailAccount(), [$messageId], $now);

            return;
        }
        $wait = self::BACKOFF[min($change->getAttempts(), \count(self::BACKOFF) - 1)];
        $change->retryLater($error, $now->add(new \DateInterval($wait)));
        // The message's later changes this worker holds wait for this one again, in order.
        foreach ($this->changes->findBy(['message' => $change->getMessage()], ['id' => 'ASC']) as $later) {
            if (strcmp($later->getId()->toRfc4122(), $change->getId()->toRfc4122()) > 0 && $later->isClaimedBy($workerId, $now)) {
                $later->release();
            }
        }
        $this->entityManager->flush();
    }

    /**
     * The folder sync found a copy of $message in $folder that it did not know. Returns whether that copy belongs to a
     * move from Tresso: then it takes the placeholder's place, or, when the user moved it on meanwhile, becomes the
     * source of that next move instead of showing up here again.
     */
    public function arrived(Message $message, Folder $folder, string $remoteUid, ?int $modSeq): bool
    {
        foreach ($this->entityManager->getRepository(MessageLocation::class)->findBy(['message' => $message, 'folder' => $folder]) as $location) {
            if ($location->isPlaceholder()) {
                $this->land($location, $remoteUid, $modSeq);

                return true;
            }
        }
        foreach ($this->changes->findBy(['message' => $message, 'sourceFolder' => $folder, 'kind' => MailboxChangeKind::Move]) as $later) {
            $source = $later->getSourceRemoteUid();
            if ($source === $remoteUid) {
                return true;
            }
            if (!self::isPlaceholderUid($source)) {
                continue;
            }
            // The move it waits on put the copy here, whether or not that move has been reported yet.
            $origin = $this->origin((string) $source);
            if (null === $origin || $origin->getTargetFolder() === $folder) {
                $later->sourceLanded($remoteUid, $folder->getUidValidity());

                return true;
            }
        }

        return false;
    }

    /**
     * A placeholder copy is now known on the server under $remoteUid: it becomes that copy, unless the folder sync
     * stored the copy already, and later moves of it can go ahead.
     */
    public function land(MessageLocation $placeholder, string $remoteUid, ?int $modSeq): void
    {
        $placeholderUid = $placeholder->getRemoteUid();
        $existing = $this->entityManager->getRepository(MessageLocation::class)->findOneBy(['folder' => $placeholder->getFolder(), 'remoteUid' => $remoteUid]);
        if (null !== $existing) {
            $this->entityManager->remove($placeholder);
        } else {
            $placeholder->landed($remoteUid, $modSeq);
        }
        $this->sourceLanded($placeholderUid, $remoteUid, $placeholder->getFolder()->getUidValidity());
    }

    /**
     * The folder is gone from the server: moves into it can no longer happen, so the messages go back where they
     * were before their placeholder copies go with the folder.
     *
     * @return list<string> ids of the messages whose moves were undone (one put back nowhere is in no folder now)
     */
    public function folderRemoved(Folder $folder): array
    {
        $messages = [];
        foreach ($this->changes->findBy(['targetFolder' => $folder]) as $move) {
            $messages[] = $move->getMessage()->getId()->toRfc4122();
            $this->undo($move, 'The folder is gone from the server.');
        }
        $this->entityManager->flush();

        return array_values(array_unique($messages));
    }

    private function sourceLanded(string $placeholderUid, string $remoteUid, ?int $uidValidity): void
    {
        foreach ($this->changes->findBy(['sourceRemoteUid' => $placeholderUid]) as $later) {
            $later->sourceLanded($remoteUid, $uidValidity);
        }
    }

    private function canMakeNow(MailboxChange $change): bool
    {
        if (MailboxChangeKind::Move === $change->getKind()) {
            return !self::isPlaceholderUid($change->getSourceRemoteUid());
        }

        // Flags go on copies the server has; while a copy is still on its way, its uid is not known yet.
        foreach ($this->pendingMoves($change) as $move) {
            if (strcmp($move->getId()->toRfc4122(), $change->getId()->toRfc4122()) < 0 || self::isPlaceholderUid($move->getSourceRemoteUid())) {
                return false;
            }
        }
        // A copy still waiting to land blocks it, unless a later move left it (that move goes after this change, and
        // the flags travel along with it; see locations()).
        foreach ($this->entityManager->getRepository(MessageLocation::class)->findBy(['message' => $change->getMessage()]) as $location) {
            if (!$location->isPlaceholder()) {
                continue;
            }
            $origin = $this->origin($location->getRemoteUid());
            if (null === $origin || strcmp($origin->getId()->toRfc4122(), $change->getId()->toRfc4122()) < 0) {
                return false;
            }
        }

        return true;
    }

    /**
     * The move is over but where its copy landed is not known yet: the placeholder (and the source of moves made of
     * the copy meanwhile) gets a fresh uid stamped with the current time, so it waits {@see PLACEHOLDER_TTL} from now
     * for the folder sync, and no longer points at a change.
     */
    private function awaitLanding(MailboxChange $change, ?MessageLocation $placeholder): void
    {
        $waiting = MailboxChange::PLACEHOLDER_PREFIX.Uuid::v7()->toRfc4122();
        if (null !== $placeholder) {
            $placeholder->restamp($waiting);
        }
        foreach ($this->changes->findBy(['sourceRemoteUid' => $change->placeholderUid()]) as $later) {
            $later->sourceLanded($waiting, $later->getSourceUidValidity());
        }
    }

    /**
     * Gives up on copies whose move is over but that never showed up within {@see PLACEHOLDER_TTL}: they were moved on
     * or deleted elsewhere before the folder sync saw them. Their placeholders go, and so do the moves made of them;
     * the folder sync shows the copy where it is.
     *
     * @return list<string> ids of the messages that lost a copy this way
     */
    private function expirePlaceholders(MailAccount $account, \DateTimeImmutable $now): array
    {
        $oldest = $now->sub(new \DateInterval(self::PLACEHOLDER_TTL));
        $expired = static function (string $placeholderUid) use ($oldest): bool {
            $id = substr($placeholderUid, \strlen(MailboxChange::PLACEHOLDER_PREFIX));
            if (!Uuid::isValid($id)) {
                return true;
            }
            $uuid = Uuid::fromString($id);

            return !$uuid instanceof UuidV7 || $uuid->getDateTime() <= $oldest;
        };

        $gaveUp = [];
        /** @var list<MessageLocation> $placeholders */
        $placeholders = $this->entityManager->createQueryBuilder()
            ->select('l')
            ->from(MessageLocation::class, 'l')
            ->where('l.mailAccount = :account')
            ->andWhere('l.remoteUid LIKE :prefix')
            ->setParameter('account', $account->getId(), 'uuid')
            ->setParameter('prefix', MailboxChange::PLACEHOLDER_PREFIX.'%')
            ->getQuery()
            ->getResult();
        foreach ($placeholders as $placeholder) {
            if (null !== $this->origin($placeholder->getRemoteUid()) || !$expired($placeholder->getRemoteUid())) {
                continue;
            }
            $this->entityManager->remove($placeholder);
            $gaveUp[] = $placeholder->getMessage()->getId()->toRfc4122();
        }

        /** @var list<MailboxChange> $stranded */
        $stranded = $this->entityManager->createQueryBuilder()
            ->select('c')
            ->from(MailboxChange::class, 'c')
            ->where('c.mailAccount = :account')
            ->andWhere('c.sourceRemoteUid LIKE :prefix')
            ->setParameter('account', $account->getId(), 'uuid')
            ->setParameter('prefix', MailboxChange::PLACEHOLDER_PREFIX.'%')
            ->getQuery()
            ->getResult();
        foreach ($stranded as $move) {
            $source = (string) $move->getSourceRemoteUid();
            if (null === $this->origin($source) && $expired($source)) {
                $this->undo($move, 'The copy it was to move never showed up.');
                $gaveUp[] = $move->getMessage()->getId()->toRfc4122();
            }
        }

        return array_values(array_unique($gaveUp));
    }

    /**
     * @return list<MailboxChange> the other moves of the change's message that the server has not confirmed yet
     */
    private function pendingMoves(MailboxChange $change): array
    {
        return array_values(array_filter(
            $this->changes->findBy(['message' => $change->getMessage(), 'kind' => MailboxChangeKind::Move], ['id' => 'ASC']),
            static fn (MailboxChange $move): bool => !$move->getId()->equals($change->getId()),
        ));
    }

    /**
     * Gives the change up and puts the message back as the server has it: the flags as they were, or the copy back in
     * the folder it was moved out of. Moves of the copy that waited on this one are given up too.
     */
    private function undo(MailboxChange $change, string $error): void
    {
        $message = $change->getMessage();
        $this->logger->warning('A change to a message could not be made on the mail server and was undone.', [
            'change' => $change->getId()->toRfc4122(),
            'kind' => $change->getKind()->value,
            'account' => $change->getMailAccount()->getId()->toRfc4122(),
            'error' => $error,
        ]);

        if (MailboxChangeKind::Flags === $change->getKind()) {
            // Only what this change set goes back: not while nothing changed it since, and not what a later change sets.
            $later = array_filter(
                $this->changes->findBy(['message' => $message, 'kind' => MailboxChangeKind::Flags]),
                static fn (MailboxChange $other): bool => strcmp($other->getId()->toRfc4122(), $change->getId()->toRfc4122()) > 0,
            );
            $setLater = static fn (callable $flag): bool => [] !== array_filter($later, static fn (MailboxChange $other): bool => null !== $flag($other));
            $seen = $message->isSeen();
            if (null !== $change->getSeen() && $seen === $change->getSeen() && !$setLater(static fn (MailboxChange $c): ?bool => $c->getSeen())) {
                $seen = !$seen;
            }
            $flagged = $message->isFlagged();
            if (null !== $change->getFlagged() && $flagged === $change->getFlagged() && !$setLater(static fn (MailboxChange $c): ?bool => $c->getFlagged())) {
                $flagged = !$flagged;
            }
            $message->updateFlags($seen, $flagged, $message->isAnswered(), $message->isDraft());
            $this->entityManager->remove($change);

            return;
        }

        $placeholder = $this->placeholder($change);
        $source = $change->getSourceFolder();
        $sourceUid = (string) $change->getSourceRemoteUid();
        if (null !== $source && !self::isPlaceholderUid($sourceUid)
            && $source->getUidValidity() === $change->getSourceUidValidity()
            && null === $this->entityManager->getRepository(MessageLocation::class)->findOneBy(['folder' => $source, 'remoteUid' => $sourceUid])) {
            $restored = new MessageLocation($message, $source, $sourceUid);
            $restored->setModSeq($change->getSourceModSeq());
            $this->entityManager->persist($restored);
        }
        // Moves of the copy made before it landed go too, whether or not its placeholder is still here.
        foreach ($this->changes->findBy(['sourceRemoteUid' => $change->placeholderUid()]) as $later) {
            $this->undo($later, 'The move it builds on was undone.');
        }
        if (null !== $placeholder) {
            $this->entityManager->remove($placeholder);
        }
        $this->entityManager->remove($change);
    }

    private function placeholder(MailboxChange $change): ?MessageLocation
    {
        $target = $change->getTargetFolder();

        return null === $target ? null : $this->entityManager->getRepository(MessageLocation::class)->findOneBy(['folder' => $target, 'remoteUid' => $change->placeholderUid()]);
    }

    /** The move that left the placeholder with this uid, while it is not confirmed yet. */
    private function origin(string $placeholderUid): ?MailboxChange
    {
        $id = substr($placeholderUid, \strlen(MailboxChange::PLACEHOLDER_PREFIX));

        return Uuid::isValid($id) ? $this->entityManager->find(MailboxChange::class, Uuid::fromString($id)) : null;
    }

    private static function isPlaceholderUid(?string $remoteUid): bool
    {
        return null !== $remoteUid && str_starts_with($remoteUid, MailboxChange::PLACEHOLDER_PREFIX);
    }
}
