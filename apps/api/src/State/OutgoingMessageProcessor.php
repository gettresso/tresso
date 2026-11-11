<?php

declare(strict_types=1);

namespace App\State;

use ApiPlatform\Metadata\Operation;
use ApiPlatform\State\ProcessorInterface;
use ApiPlatform\Validator\Exception\ValidationException;
use App\ApiResource\Input\Outbox\RecipientInput;
use App\ApiResource\Input\Outbox\SendMessageInput;
use App\ApiResource\OutgoingMessageResource;
use App\Entity\Draft;
use App\Entity\MailAccount;
use App\Entity\Message;
use App\Entity\OutgoingMessage;
use App\Enum\DraftKind;
use App\Enum\OutgoingStatus;
use App\HandOver\HandOvers;
use App\Outbox\AttachmentLimits;
use App\Outbox\Composition;
use App\Outbox\DraftFiling;
use App\Outbox\MissingAttachment;
use App\Outbox\OutgoingAttachment;
use App\Outbox\Outbox;
use App\Repository\DraftRepository;
use App\Repository\MailAccountRepository;
use App\Repository\MessageRepository;
use App\Repository\OutgoingMessageRepository;
use App\Scan\AttachmentAccess;
use App\Scan\DownloadPolicy;
use App\Security\CurrentUser;
use App\Unsubscribe\Unsubscriptions;
use Doctrine\DBAL\LockMode;
use Doctrine\ORM\EntityManagerInterface;
use Symfony\Component\HttpKernel\Exception\ConflictHttpException;
use Symfony\Component\HttpKernel\Exception\NotFoundHttpException;
use Symfony\Component\Uid\Uuid;
use Symfony\Component\Validator\ConstraintViolation;
use Symfony\Component\Validator\ConstraintViolationList;

/**
 * @implements ProcessorInterface<SendMessageInput|OutgoingMessageResource, OutgoingMessageResource>
 */
final readonly class OutgoingMessageProcessor implements ProcessorInterface
{
    public function __construct(
        private EntityManagerInterface $entityManager,
        private Outbox $outbox,
        private CurrentUser $currentUser,
        private MailAccountRepository $accounts,
        private MessageRepository $messages,
        private OutgoingMessageRepository $outgoing,
        private DraftRepository $drafts,
        private DraftFiling $filing,
        private AttachmentLimits $limits,
        private DownloadPolicy $downloads,
        private Unsubscriptions $unsubscriptions,
        private HandOvers $handOvers,
    ) {
    }

    public function process(mixed $data, Operation $operation, array $uriVariables = [], array $context = []): OutgoingMessageResource
    {
        $user = $this->currentUser->get();

        if ($data instanceof SendMessageInput) {
            $account = $this->accounts->findOneOwnedBy($user, $data->mailAccountId);
            if (!$account instanceof MailAccount) {
                throw self::invalid('mailAccountId', 'No mail account with that id.', $data->mailAccountId);
            }
            $inReplyTo = null;
            if (null !== $data->inReplyToMessageId) {
                $inReplyTo = $this->messages->findOneOwnedBy($user, $data->inReplyToMessageId);
                if (!$inReplyTo instanceof Message) {
                    throw self::invalid('inReplyToMessageId', 'No message with that id.', $data->inReplyToMessageId);
                }
            }
            $now = new \DateTimeImmutable();
            $composition = new Composition(
                $account,
                self::recipients($data->to),
                self::recipients($data->cc),
                self::recipients($data->bcc),
                trim($data->subject),
                $data->html,
                $inReplyTo,
                null === $data->sendAt || $data->sendAt < $now ? $now : $data->sendAt,
            );

            $draftId = $data->draftId;
            $acceptUnscanned = $data->acceptUnscanned;
            $id = null === $data->outgoingId ? null : Uuid::fromString($data->outgoingId);
            if (null !== $draftId && !$this->drafts->findOneOwnedBy($user, $draftId) instanceof Draft) {
                throw self::invalid('draftId', 'No draft with that id.', $draftId);
            }

            return OutgoingMessageResource::fromEntity($this->entityManager->wrapInTransaction(function () use ($composition, $now, $draftId, $user, $acceptUnscanned, $id): OutgoingMessage {
                // A request sent again (its answer got lost) gets the message the first one queued. The lock makes two
                // at once take turns, so the second sees the first.
                if (null !== $id) {
                    $this->entityManager->getConnection()->executeStatement('SELECT pg_advisory_xact_lock(hashtextextended(:key, 0))', ['key' => 'outgoing:'.$id->toRfc4122()]);
                    $existing = $this->entityManager->find(OutgoingMessage::class, $id);
                    if (null !== $existing) {
                        if (!$existing->getMailAccount()->getOwner()->getId()->equals($user->getId())) {
                            throw new ConflictHttpException('This id is taken; choose another.');
                        }

                        return $existing;
                    }
                }
                // Locked before anything is built, so its attachments cannot change and it is sent once.
                $draft = null;
                if (null !== $draftId) {
                    $owned = $this->drafts->findOneOwnedBy($user, $draftId);
                    $draft = null === $owned ? null : $this->entityManager->find(Draft::class, $owned->getId(), LockMode::PESSIMISTIC_WRITE);
                    if (!$draft instanceof Draft || $draft->isSending()) {
                        throw new ConflictHttpException('This draft is being sent already.');
                    }
                    $composition = $this->withAttachments($composition, $draft, $acceptUnscanned);
                }
                try {
                    $queued = $this->outbox->queue($composition, $now, $id);
                } catch (MissingAttachment $exception) {
                    throw self::invalid('draftId', $exception->getMessage().' Remove it and attach it again.', $draftId ?? '');
                }
                if (null !== $draft) {
                    $this->filing->sending($draft, $queued);
                }
                // A reply to someone a conversation was handed over to follows that hand-over up; a forward does not.
                $this->handOvers->messageQueued($queued, self::isForward($draft, $composition->subject), $now);

                return $queued;
            }));
        }

        $id = $uriVariables['id'] ?? null;
        $owned = \is_string($id) ? $this->outgoing->findOneOwnedBy($user, $id) : null;
        if (!$owned instanceof OutgoingMessage) {
            throw new NotFoundHttpException('Outgoing message not found.');
        }

        return OutgoingMessageResource::fromEntity($this->entityManager->wrapInTransaction(function () use ($owned): OutgoingMessage {
            $message = $this->entityManager->find(OutgoingMessage::class, $owned->getId(), LockMode::PESSIMISTIC_WRITE);
            if (!$message instanceof OutgoingMessage) {
                throw new NotFoundHttpException('Outgoing message not found.');
            }
            if (!\in_array($message->getStatus(), [OutgoingStatus::Scheduled, OutgoingStatus::Queued], true)) {
                throw new ConflictHttpException(\sprintf('This message is %s and can no longer be cancelled.', $message->getStatus()->value));
            }
            $this->outbox->cancel($message);
            $this->unsubscriptions->outgoingSettled($message, new \DateTimeImmutable());

            return $message;
        }));
    }

    /**
     * The draft's attachments go with the message: each must have passed the scan, or have been confirmed by the user
     * when it could not be scanned (see {@see DownloadPolicy}), and together they must fit the size a mail server
     * takes.
     */
    private function withAttachments(Composition $composition, Draft $draft, bool $acceptUnscanned): Composition
    {
        $total = 0;
        foreach ($draft->getAttachments() as $attachment) {
            $refusal = $this->downloads->sendingRefusal($attachment->getScanStatus(), $attachment->getFilename(), $acceptUnscanned);
            if (null !== $refusal) {
                // A file that only needs the user's confirmation is answered on `acceptUnscanned`, so clients can ask.
                $confirmable = AttachmentAccess::Confirm === $this->downloads->access($attachment->getScanStatus());
                throw $confirmable ? self::invalid('acceptUnscanned', $refusal, '') : self::invalid('draftId', $refusal, $draft->getId()->toRfc4122());
            }
            $total += $attachment->getSize();
        }
        if ($total > $this->limits->maxAttachmentBytes) {
            throw self::invalid('draftId', \sprintf('The attachments are too large together (at most %s).', AttachmentLimits::describe($this->limits->maxAttachmentBytes)), $draft->getId()->toRfc4122());
        }

        return new Composition(
            $composition->account,
            $composition->to,
            $composition->cc,
            $composition->bcc,
            $composition->subject,
            $composition->html,
            $composition->inReplyTo,
            $composition->sendAt,
            array_map(OutgoingAttachment::fromDraft(...), $draft->getAttachments()),
        );
    }

    private static function invalid(string $path, string $message, string $value): ValidationException
    {
        return new ValidationException(new ConstraintViolationList([new ConstraintViolation($message, null, [], null, $path, $value)]));
    }

    /**
     * @param list<RecipientInput> $recipients
     *
     * @return list<array{address: string, name: ?string}>
     */
    private static function recipients(array $recipients): array
    {
        return array_map(static fn (RecipientInput $recipient): array => $recipient->toArray(), $recipients);
    }

    /** Written as a forward: its draft says so, or, sent without a draft on the server, its subject does. */
    private static function isForward(?Draft $draft, string $subject): bool
    {
        if (null !== $draft) {
            return DraftKind::Forward === $draft->getKind();
        }

        return 1 === preg_match('/^\s*(fwd?|fw)\s*:/i', $subject);
    }
}
