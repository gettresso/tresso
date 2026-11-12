<?php

declare(strict_types=1);

namespace App\ApiResource\Input\Chat;

use App\Chat\ChatTime;
use Symfony\Component\Validator\Constraints as Assert;

/**
 * What the user changes of a chat; a field left out stays as it is. Read and archive are Tresso's own and never reach
 * WhatsApp. `readThrough` and `archivedThrough` only move forward (an older time is ignored, so two devices never undo
 * each other); `archivedThrough: null` puts the chat back in the inbox.
 */
final class UpdateChat
{
    #[Assert\LessThanOrEqual(ChatTime::MAX_AHEAD, message: 'This time lies in the future; check the clock of this device.')]
    public ?\DateTimeImmutable $readThrough = null;

    #[Assert\LessThanOrEqual(ChatTime::MAX_AHEAD, message: 'This time lies in the future; check the clock of this device.')]
    private ?\DateTimeImmutable $archivedThrough = null;

    /** Whether the request named `archivedThrough`, so null (back in the inbox) differs from left out. */
    private bool $archivedThroughGiven = false;

    /** True removes the chat's messages and replies from the server and takes no more; false takes them again. */
    public ?bool $leftOut = null;

    public function getArchivedThrough(): ?\DateTimeImmutable
    {
        return $this->archivedThrough;
    }

    public function setArchivedThrough(?\DateTimeImmutable $archivedThrough): void
    {
        $this->archivedThrough = $archivedThrough;
        $this->archivedThroughGiven = true;
    }

    public function changesArchive(): bool
    {
        return $this->archivedThroughGiven;
    }
}
