<?php

declare(strict_types=1);

namespace App\Sync\Ingest;

use App\ApiResource\Input\Sync\AddressInput;
use App\ApiResource\Input\Sync\MessageBatchInput;
use App\ApiResource\Input\Sync\MessageInput;
use App\Calendar\Invitation\InvitationRecorder;
use App\Classification\ClassificationScheduler;
use App\Entity\Attachment;
use App\Entity\Folder;
use App\Entity\MailAccount;
use App\Entity\Message;
use App\Entity\MessageLocation;
use App\Entity\MessageReference;
use App\Entity\MessageSignals;
use App\Enum\FolderRole;
use App\HandOver\HandOvers;
use App\Mail\MessageFields;
use App\Mailbox\MailboxChanges;
use App\Repository\MailAccountRepository;
use App\Repository\MailboxChangeRepository;
use Doctrine\ORM\EntityManagerInterface;

/**
 * Stores a batch of messages for one folder. Resending a batch changes nothing: a known (folder, uid) only refreshes
 * flags, and a message already stored for the account (same raw content, or the same Message-ID with the same sender,
 * Date and subject) only gains a location.
 */
final readonly class MessageIngestor
{
    public function __construct(
        private EntityManagerInterface $entityManager,
        private Threader $threader,
        private FolderLookup $folders,
        private MailboxChangeRepository $mailboxChanges,
        private MailboxChanges $changes,
        private ClassificationScheduler $classification,
        private InvitationRecorder $invitations,
        private HandOvers $handOvers,
        private MessageFields $fields,
        private MailAccountRepository $accounts,
    ) {
    }

    public function ingest(MailAccount $account, MessageBatchInput $batch): MessageBatchResult
    {
        return $this->entityManager->wrapInTransaction(function () use ($account, $batch): MessageBatchResult {
            $folder = $this->folders->get($account, $batch->folder);
            $stored = $linked = $updated = 0;
            $pendingFlags = $this->mailboxChanges->messagesWithPendingFlags($account);
            $ownAddresses = $this->ownAddresses($account);

            foreach ($batch->messages as $input) {
                $location = $this->entityManager->getRepository(MessageLocation::class)->findOneBy(['folder' => $folder, 'remoteUid' => $input->remoteUid]);
                if (null !== $location) {
                    $this->applyFlags($location->getMessage(), $input, $pendingFlags);
                    $location->setModSeq($input->modSeq);
                    ++$updated;
                    continue;
                }

                $messageId = MessageIds::normalize($input->messageId);
                $existing = $this->findExisting($account, $messageId, $input);
                if (null !== $existing) {
                    // A copy a move from Tresso put here is not new: it lands instead.
                    if (!$this->changes->arrived($existing, $folder, $input->remoteUid, $input->modSeq)) {
                        $this->addLocation($existing, $folder, $input);
                    }
                    // Moved into the inbox, or out of Spam: its calendar mail counts now.
                    $this->invitations->arrived($existing, $folder->getRole(), $input->calendarParts);
                    $this->applyFlags($existing, $input, $pendingFlags);
                    // A delegate's answer rescued from Spam closes their hand-over now.
                    if (FolderRole::Inbox === $folder->getRole()) {
                        $this->entityManager->flush();
                        $this->handOvers->messageArrived($existing, MessageIds::normalizeList([...$input->references, $input->inReplyTo], $messageId), $input->headers, $input->junk, $folder->getRole(), new \DateTimeImmutable());
                    }
                    ++$linked;
                    continue;
                }

                $this->store($account, $folder, $input, $messageId, $ownAddresses);
                ++$stored;
            }

            if (null !== $batch->cursor) {
                $folder->updateSyncState($folder->getUidValidity(), $batch->cursor);
            }
            $this->entityManager->flush();

            return new MessageBatchResult($stored, $linked, $updated);
        });
    }

    /**
     * @param array<string, true> $ownAddresses the owner's account addresses, lowercased
     */
    private function store(MailAccount $account, Folder $folder, MessageInput $input, ?string $messageId, array $ownAddresses): void
    {
        $from = $input->from ?? throw new \LogicException('Validation guarantees a sender.');
        // In UTC like every stored time, also for the thread and the subject window below.
        $receivedAt = ($input->receivedAt ?? throw new \LogicException('Validation guarantees a received date.'))->setTimezone(new \DateTimeZone('UTC'));
        $references = MessageIds::normalizeList([...$input->references, $input->inReplyTo], $messageId);

        // The people on the other side: the owner's own addresses are on nearly every message and say nothing.
        $counterparts = array_values(array_filter(
            array_unique(array_map(static fn (AddressInput $address): string => mb_strtolower($address->address), [$from, ...$input->to, ...$input->cc])),
            static fn (string $address): bool => !isset($ownAddresses[$address]),
        ));
        $thread = $this->threader->threadFor($account, $messageId, $references, $input->subject, $counterparts, $receivedAt);

        $keyVersion = $input->keyVersion ?? throw new \LogicException('Validation guarantees a key version.');
        $message = new Message($account, $thread, $messageId, $input->subject, $from->address, $from->name, $receivedAt, $input->rawObjectKey, $keyVersion);
        $message->setInReplyTo(MessageIds::normalize($input->inReplyTo));
        $message->setSentAt($input->sentAt);
        $message->setSize($input->size);
        $message->setRecipients([
            'to' => self::addresses($input->to),
            'cc' => self::addresses($input->cc),
            'bcc' => self::addresses($input->bcc),
            'replyTo' => self::addresses($input->replyTo),
        ]);
        $this->applyFlags($message, $input, []);
        $this->entityManager->persist($message);
        $this->fields->sealSnippet($message, $input->snippet);
        $thread->recordMessage($receivedAt);

        if ([] !== $input->headers || $input->junk) {
            $this->entityManager->persist(new MessageSignals($message, $input->headers, $input->junk));
        }
        $this->classification->mailArrived($account->getOwner()->getId());

        if ('' !== $input->bodyText) {
            $this->entityManager->persist($this->fields->newText($message, $input->bodyText));
        }

        foreach ($references as $reference) {
            $this->entityManager->persist(new MessageReference($message, $reference));
        }

        $hasAttachments = false;
        $scanStatuses = [];
        foreach ($input->attachments as $attachmentInput) {
            $attachment = new Attachment($message, $attachmentInput->filename, $attachmentInput->contentType, $attachmentInput->size, $attachmentInput->fingerprint, $keyVersion, $attachmentInput->contentId);
            if ($attachmentInput->inline && null !== $attachment->getContentId()) {
                $attachment->markInline();
            } else {
                $hasAttachments = true;
            }
            $this->entityManager->persist($attachment);
            $scanStatuses[] = $attachment->getScanStatus();
        }
        $message->setHasAttachments($hasAttachments);
        $message->summarizeAttachmentScans($scanStatuses);

        $this->invitations->arrived($message, $folder->getRole(), $input->calendarParts);

        $this->addLocation($message, $folder, $input);

        // Flushed per message so the next message in the batch can thread onto this one.
        $this->entityManager->flush();

        // The delegate's reply closes the hand-over of this conversation.
        $this->handOvers->messageArrived($message, $references, $input->headers, $input->junk, $folder->getRole(), new \DateTimeImmutable());
    }

    /**
     * The stored message this copy is another copy of. A Message-ID alone does not say so: devices and scripts reuse
     * them, list servers rewrite mail, and anyone who saw a mail can copy its id. So a message with the same Message-ID
     * counts only with the same raw content, or, for a copy the server rewrote (another folder, a list copy), with the
     * same sender, Date header and subject. Anything else is a mail of its own.
     */
    private function findExisting(MailAccount $account, ?string $messageId, MessageInput $input): ?Message
    {
        $repository = $this->entityManager->getRepository(Message::class);

        if (null === $messageId) {
            return $repository->findOneBy(['mailAccount' => $account, 'rawObjectKey' => $input->rawObjectKey]);
        }

        $from = mb_strtolower($input->from->address ?? '');
        foreach ($repository->findBy(['mailAccount' => $account, 'messageIdHeader' => $messageId], ['id' => 'ASC']) as $candidate) {
            if ($candidate->getRawObjectKey() === $input->rawObjectKey) {
                return $candidate;
            }
            if ($candidate->getFromAddress() === $from && $candidate->getSubject() === $input->subject && self::sameDate($candidate->getSentAt(), $input->sentAt)) {
                return $candidate;
            }
        }

        return null;
    }

    /**
     * Whether two Date headers are the same. Messages stored before dates were kept in UTC hold the sender's wall clock
     * read as UTC, so that reading counts too.
     */
    private static function sameDate(?\DateTimeImmutable $stored, ?\DateTimeImmutable $received): bool
    {
        if (null === $stored || null === $received) {
            return $stored === $received;
        }

        return $stored == $received || $stored->format('Y-m-d H:i:s') === $received->format('Y-m-d H:i:s');
    }

    /**
     * @return array<string, true> the addresses of all the owner's accounts, lowercased
     */
    private function ownAddresses(MailAccount $account): array
    {
        $own = [mb_strtolower($account->getEmailAddress()) => true];
        foreach ($this->accounts->findOwnedBy($account->getOwner()) as $other) {
            $own[mb_strtolower($other->getEmailAddress())] = true;
        }

        return $own;
    }

    private function addLocation(Message $message, Folder $folder, MessageInput $input): void
    {
        $location = new MessageLocation($message, $folder, $input->remoteUid);
        $location->setModSeq($input->modSeq);
        $this->entityManager->persist($location);
    }

    /**
     * @param array<string, true> $pendingFlags messages with a flag change from Tresso the server has not confirmed:
     *                                          their \Seen and \Flagged stay as the user set them meanwhile
     */
    private function applyFlags(Message $message, MessageInput $input, array $pendingFlags): void
    {
        if (isset($pendingFlags[$message->getId()->toRfc4122()])) {
            $message->updateFlags($message->isSeen(), $message->isFlagged(), $input->flags->answered, $input->flags->draft);

            return;
        }
        $message->updateFlags($input->flags->seen, $input->flags->flagged, $input->flags->answered, $input->flags->draft);
    }

    /**
     * @param list<AddressInput> $addresses
     *
     * @return list<array{address: string, name: ?string}>
     */
    private static function addresses(array $addresses): array
    {
        return array_map(static fn (AddressInput $address): array => ['address' => mb_strtolower($address->address), 'name' => $address->name], $addresses);
    }
}
