<?php

declare(strict_types=1);

namespace App\ApiResource\Input\Chat;

use App\Chat\ChatJid;
use App\Enum\ChatKind;
use Symfony\Component\Validator\Constraints as Assert;
use Symfony\Component\Validator\Context\ExecutionContextInterface;

/**
 * A chat that messages of the call belong to, as the bridge's store names it.
 */
final class RelayChat
{
    /** Longer than any JID; checked against the rule of {@see ChatJid}. */
    public const int MAX_JID = 128;

    /** What the desktop cuts a text or name at (WhatsApp's own limit for a text); a longer one is a broken client. */
    public const int MAX_FIELD = 65_536;

    #[Assert\NotBlank]
    #[Assert\Length(max: self::MAX_JID)]
    public string $jid = '';

    /** The chat's name; null when the bridge has none. Stored cut to 255 characters, without control characters. */
    #[Assert\Length(max: self::MAX_FIELD)]
    public ?string $name = null;

    #[Assert\NotNull]
    public ?ChatKind $kind = null;

    #[Assert\Callback]
    public function validateJid(ExecutionContextInterface $context): void
    {
        if ('' === $this->jid || mb_strlen($this->jid) > self::MAX_JID) {
            return;
        }
        $address = ChatJid::parse($this->jid);
        if (null === $address) {
            $context->buildViolation('This is not a direct chat or a group.')->atPath('jid')->addViolation();
        } elseif (null !== $this->kind && $address->kind !== $this->kind) {
            $context->buildViolation('The kind does not match the chat.')->atPath('kind')->addViolation();
        }
    }
}
