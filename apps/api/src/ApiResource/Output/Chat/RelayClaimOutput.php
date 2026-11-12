<?php

declare(strict_types=1);

namespace App\ApiResource\Output\Chat;

/**
 * The reply the relay sends now: to which chat, and what it says. `claimToken` is this claim's secret: the result carries
 * it back, so a result is taken only for this claim and only from the relay that made it. No other answer and no delta
 * ever carries it.
 */
final readonly class RelayClaimOutput
{
    public function __construct(
        public string $id,
        public string $chatId,
        public string $chatJid,
        public string $text,
        public string $claimToken,
    ) {
    }
}
