<?php

declare(strict_types=1);

namespace App\ApiResource\Input\Chat;

use App\Chat\ChatJid;
use Symfony\Component\Validator\Constraints as Assert;
use Symfony\Component\Validator\Context\ExecutionContextInterface;

/**
 * A batch of messages from the bridge's store, with the chats they belong to. Safe to send again: a message the server
 * has is reported `known` and left as it is. The relay moves its cursor on only after a 200.
 */
final class RelayMessages extends RelayRequest
{
    public const int MAX_MESSAGES = 200;
    public const int MAX_CHATS = 200;

    /**
     * Bytes a call may have: 200 messages of a few kilobytes fit many times over, while PHP keeps the decoded batch
     * and its sealed copy well within its memory limit (256 MB). A larger batch is answered 413 `too_large`.
     */
    public const int MAX_BYTES = 8 * 1024 * 1024;

    /** True while the relay imports the history it found when it started: those messages arrive read. */
    public bool $firstImport = false;

    /** @var list<RelayChat> */
    #[Assert\Count(max: self::MAX_CHATS)]
    #[Assert\Valid]
    public array $chats = [];

    /** @var list<RelayMessage> */
    #[Assert\Count(max: self::MAX_MESSAGES)]
    #[Assert\Valid]
    public array $messages = [];

    #[Assert\Callback]
    public function validateChats(ExecutionContextInterface $context): void
    {
        $seen = [];
        foreach ($this->chats as $i => $chat) {
            $canonical = ChatJid::parse($chat->jid)?->canonical();
            if (null === $canonical) {
                continue;
            }
            if (isset($seen[$canonical])) {
                $context->buildViolation('This chat is in the request twice.')->atPath(\sprintf('chats[%d].jid', $i))->addViolation();
            }
            $seen[$canonical] = true;
        }
    }
}
