<?php

declare(strict_types=1);

namespace App\ApiResource\Input\Chat;

use App\Chat\ChatJid;
use App\Chat\ChatTime;
use Symfony\Component\Validator\Constraints as Assert;
use Symfony\Component\Validator\Context\ExecutionContextInterface;

/**
 * One message of the bridge's store. The server knows it again by its chat and WhatsApp id, so sending it twice
 * stores it once.
 */
final class RelayMessage
{
    #[Assert\NotBlank]
    #[Assert\Length(max: RelayChat::MAX_JID)]
    public string $chatJid = '';

    /** The bridge's message id. */
    #[Assert\NotBlank]
    #[Assert\Regex('/^[\x21-\x7E]{1,128}$/D', message: 'A WhatsApp id is at most 128 visible ASCII characters.')]
    public string $waId = '';

    public bool $fromMe = false;

    /** Who wrote it in a group; null for the user's own messages and in a direct chat. */
    #[Assert\Valid]
    public ?RelaySender $sender = null;

    /** The text, or a file's caption; empty when there is none. */
    #[Assert\Length(max: RelayChat::MAX_FIELD)]
    public string $text = '';

    #[Assert\NotNull]
    #[Assert\GreaterThanOrEqual(ChatTime::EARLIEST, message: 'This time lies before WhatsApp existed.')]
    #[Assert\LessThanOrEqual(ChatTime::MAX_AHEAD, message: 'This time lies in the future; check the clock of this device.')]
    public ?\DateTimeImmutable $sentAt = null;

    #[Assert\Valid]
    public ?RelayMedia $media = null;

    #[Assert\Callback]
    public function validateChatJid(ExecutionContextInterface $context): void
    {
        if ('' !== $this->chatJid && mb_strlen($this->chatJid) <= RelayChat::MAX_JID && null === ChatJid::parse($this->chatJid)) {
            $context->buildViolation('This is not a direct chat or a group.')->atPath('chatJid')->addViolation();
        }
    }
}
