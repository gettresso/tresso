<?php

declare(strict_types=1);

namespace App\ApiResource\Input\Chat;

use App\Enum\ChatOutgoingError;
use Symfony\Component\Validator\Constraints as Assert;
use Symfony\Component\Validator\Context\ExecutionContextInterface;

/**
 * What became of a reply the relay claimed, as the desktop shell's send reports it: sent, or why not. `unconfirmed`
 * means the bridge was asked and no answer came: it may have gone out, so nothing sends it again until the user
 * presses Try again.
 */
final class RelayResult extends RelayRequest
{
    /** The claim this result is for: `claimedAt` as the claim answered it. */
    #[Assert\NotNull]
    public ?\DateTimeImmutable $claimedAt = null;

    #[Assert\NotNull]
    public ?bool $sent = null;

    /** Why it was not sent; null when it was. */
    public ?ChatOutgoingError $error = null;

    #[Assert\Callback]
    public function validateError(ExecutionContextInterface $context): void
    {
        if (true === $this->sent && null !== $this->error) {
            $context->buildViolation('A reply that was sent has no error.')->atPath('error')->addViolation();
        }
        if (false === $this->sent && null === $this->error) {
            $context->buildViolation('Say why the reply was not sent.')->atPath('error')->addViolation();
        }
    }
}
