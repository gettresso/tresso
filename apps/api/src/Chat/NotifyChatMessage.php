<?php

declare(strict_types=1);

namespace App\Chat;

/**
 * Sent a little after a relay batch stored a chat's newest incoming message: tells the user on the phone, when the
 * account's Notify me is on ({@see ChatNotifier}).
 */
final readonly class NotifyChatMessage
{
    public function __construct(public string $messageId)
    {
    }
}
