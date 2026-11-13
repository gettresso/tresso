<?php

declare(strict_types=1);

namespace App\ApiResource\Output\Chat;

/**
 * The reply the relay sends now: to which chat, and what it says. `claimToken` is this claim's secret: the result carries
 * it back, so a result is taken only for this claim and only from the relay that made it. No other answer and no delta
 * ever carries it.
 *
 * `file` is the file the reply carries, or null: its name, its size in bytes and a signed link to its content, valid for
 * an hour, which the relay fetches right away and hands to the bridge.
 */
final readonly class RelayClaimOutput
{
    /**
     * @param array{name: string, size: int, url: string}|null $file
     */
    public function __construct(
        public string $id,
        public string $chatId,
        public string $chatJid,
        public string $text,
        public string $claimToken,
        public ?array $file = null,
    ) {
    }
}
