<?php

declare(strict_types=1);

namespace App\ApiResource\Output\Chat;

/**
 * The reply the relay sends now: to which chat, and what it says. `claimedAt` names this claim: the result carries it
 * back, so a result is never taken for another claim of the same reply.
 */
final readonly class RelayClaimOutput
{
    public function __construct(
        public string $id,
        public string $chatId,
        public string $chatJid,
        public string $text,
        public string $claimedAt,
    ) {
    }
}
