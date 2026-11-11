<?php

declare(strict_types=1);

namespace App\ApiResource\Input\Outbox;

use Symfony\Component\Uid\Uuid;
use Symfony\Component\Uid\UuidV7;
use Symfony\Component\Validator\ConstraintViolation;
use Symfony\Component\Validator\ConstraintViolationList;
use Symfony\Component\Validator\Constraints as Assert;
use Symfony\Component\Validator\Context\ExecutionContextInterface;

/**
 * A message to send from one of the user's accounts. Without sendAt it goes out right away; a sendAt in the future
 * schedules it (send later, or a few seconds for an undo window) until then it can be cancelled.
 */
final class SendMessageInput
{
    private const int MAX_RECIPIENTS = 100;
    /** How far ahead of the server an outgoingId may be: the clock skew workers allow for (see timeViolations()). */
    private const string ID_AHEAD = '5 minutes';

    /**
     * The id the client chose for the outgoing message, a UUIDv7 made when the user hit send: a request sent again with
     * the same id (its answer got lost) returns the message queued the first time instead of sending it twice, however
     * late it comes.
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
     * The checks that depend on when the request arrives. They run only for a message that is not queued yet (see
     * OutgoingMessageProcessor): a request sent again for one that is gets it back, however late it comes, so a lost
     * answer never turns into a refusal for mail that is on its way.
     *
     * - sendAt must not lie in the past (a minute of slack) nor more than a year ahead.
     * - outgoingId: workers look for an earlier attempt from the time in the id on, less five minutes for clock skew
     *   (see the outbox in docs/ARCHITECTURE.md). An id ahead of the server by more than that would make them miss an
     *   attempt, so it is refused. An old id only makes that look reach further back (a bit more work, never a wrong
     *   answer), and nothing else depends on its age, so there is no lower bound: a send the user started days ago and
     *   whose first request never arrived still goes out.
     */
    public function timeViolations(\DateTimeImmutable $now): ConstraintViolationList
    {
        $violations = new ConstraintViolationList();
        if (null !== $this->sendAt && $this->sendAt < $now->modify('-1 minute')) {
            $violations->add(new ConstraintViolation('The send time is in the past.', null, [], $this, 'sendAt', $this->sendAt));
        }
        if (null !== $this->sendAt && $this->sendAt > $now->modify('+1 year')) {
            $violations->add(new ConstraintViolation('Messages can be scheduled up to a year ahead.', null, [], $this, 'sendAt', $this->sendAt));
        }
        if (null !== $this->outgoingId && Uuid::isValid($this->outgoingId)) {
            $id = Uuid::fromString($this->outgoingId);
            if ($id instanceof UuidV7 && $id->getDateTime() > $now->modify('+'.self::ID_AHEAD)) {
                $violations->add(new ConstraintViolation('The id lies in the future; check the clock of this device.', null, [], $this, 'outgoingId', $this->outgoingId));
            }
        }

        return $violations;
    }
}
