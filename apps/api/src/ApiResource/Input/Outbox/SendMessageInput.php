<?php

declare(strict_types=1);

namespace App\ApiResource\Input\Outbox;

use Symfony\Component\Uid\Uuid;
use Symfony\Component\Uid\UuidV7;
use Symfony\Component\Validator\Constraints as Assert;
use Symfony\Component\Validator\Context\ExecutionContextInterface;

/**
 * A message to send from one of the user's accounts. Without sendAt it goes out right away; a sendAt in the future
 * schedules it (send later, or a few seconds for an undo window) until then it can be cancelled.
 */
final class SendMessageInput
{
    private const int MAX_RECIPIENTS = 100;

    /**
     * The id the client chose for the outgoing message, a UUIDv7 made when the user hit send: a request sent again with
     * the same id (its answer got lost) returns the message queued the first time instead of sending it twice.
     */
    #[Assert\Uuid(versions: [Assert\Uuid::V7_MONOTONIC])]
    public ?string $outgoingId = null;

    #[Assert\NotBlank]
    #[Assert\Uuid]
    public string $mailAccountId = '';

    /** @var list<RecipientInput> */
    #[Assert\Valid]
    public array $to = [];

    /** @var list<RecipientInput> */
    #[Assert\Valid]
    public array $cc = [];

    /** @var list<RecipientInput> */
    #[Assert\Valid]
    public array $bcc = [];

    #[Assert\Length(max: 998)]
    #[Assert\Regex(pattern: '/[\r\n]/', match: false, message: 'The subject cannot contain line breaks.')]
    public string $subject = '';

    #[Assert\Length(max: 2_000_000)]
    public string $html = '';

    /** The message this one answers or forwards: it keeps the conversation together for every recipient. */
    #[Assert\Uuid]
    public ?string $inReplyToMessageId = null;

    public ?\DateTimeImmutable $sendAt = null;

    /** The draft this message was written in: it is removed, here and from the Drafts folder, once queued. */
    #[Assert\Uuid]
    public ?string $draftId = null;

    /** The user confirmed sending the draft's files that could not be scanned for malware. */
    public bool $acceptUnscanned = false;

    #[Assert\Callback]
    public function validateRecipients(ExecutionContextInterface $context): void
    {
        $count = \count($this->to) + \count($this->cc) + \count($this->bcc);
        if (0 === $count) {
            $context->buildViolation('Add at least one recipient.')->atPath('to')->addViolation();
        }
        if ($count > self::MAX_RECIPIENTS) {
            $context->buildViolation(\sprintf('A message can have at most %d recipients.', self::MAX_RECIPIENTS))->atPath('to')->addViolation();
        }
    }

    /**
     * Workers look for an earlier attempt from the time in the id on (see the outbox in docs/ARCHITECTURE.md), so it
     * must not lie ahead of when the message is written.
     */
    #[Assert\Callback]
    public function validateId(ExecutionContextInterface $context): void
    {
        if (null === $this->outgoingId || !Uuid::isValid($this->outgoingId)) {
            return;
        }
        $id = Uuid::fromString($this->outgoingId);
        if (!$id instanceof UuidV7) {
            return;
        }
        $now = new \DateTimeImmutable();
        $made = $id->getDateTime();
        if ($made > $now->modify('+1 minute') || $made < $now->modify('-1 day')) {
            $context->buildViolation('The id must be a UUIDv7 made when the message is sent.')->atPath('outgoingId')->addViolation();
        }
    }

    #[Assert\Callback]
    public function validateSendAt(ExecutionContextInterface $context): void
    {
        if (null === $this->sendAt) {
            return;
        }
        $now = new \DateTimeImmutable();
        if ($this->sendAt < $now->modify('-1 minute')) {
            $context->buildViolation('The send time is in the past.')->atPath('sendAt')->addViolation();
        }
        if ($this->sendAt > $now->modify('+1 year')) {
            $context->buildViolation('Messages can be scheduled up to a year ahead.')->atPath('sendAt')->addViolation();
        }
    }
}
