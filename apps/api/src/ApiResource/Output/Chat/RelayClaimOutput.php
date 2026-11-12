<?php

declare(strict_types=1);

namespace App\ApiResource\Output\Chat;

/**
 * The reply the relay sends now: to which chat, and what it says.
 */
final readonly class RelayClaimOutput
{
    public function __construct(
        public string $id,
        public string $chatId,
        public string $chatJid,
        public string $text,
    ) {
    }
}
