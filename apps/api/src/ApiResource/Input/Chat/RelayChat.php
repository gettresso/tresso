<?php

declare(strict_types=1);

namespace App\ApiResource\Input\Chat;

use App\Chat\ChatJid;
use App\Enum\ChatKind;
use Symfony\Component\Validator\Constraints as Assert;
use Symfony\Component\Validator\Context\ExecutionContextInterface;

/**
 * A chat that messages of the call belong to, as the bridge's store names it. A JID that is not a chat Tresso takes is
 * not refused here: the chat is left aside, and its messages are refused one by one ({@see \App\Chat\ChatIngestor}).
 */
final class RelayChat
{

    /** What the desktop cuts a text or name at (WhatsApp's own limit for a text); a longer one is a broken client. */
    public const int MAX_FIELD = 65_536;

    #[Assert\Length(max: RelayMessage::MAX_ID)]
    public string $jid = '';

    /** The chat's name; null when the bridge has none. Stored cut to 255 characters, without control characters. */
    #[Assert\Length(max: self::MAX_FIELD)]
    #[Assert\Length(max: RelayMessage::MAX_FIELD_BYTES, countUnit: Assert\Length::COUNT_BYTES)]
    public ?string $name = null;

    #[Assert\NotNull]
    public ?ChatKind $kind = null;

    /** The kind the relay derives from the JID; another one is the relay's own bug. */
    #[Assert\Callback]
    public function validateKind(ExecutionContextInterface $context): void
    {
        $address = ChatJid::parse($this->jid);
        if (null !== $address && null !== $this->kind && $address->kind !== $this->kind) {
            $context->buildViolation('The kind does not match the chat.')->atPath('kind')->addViolation();
        }
    }
}
