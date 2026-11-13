<?php

declare(strict_types=1);

namespace App\ApiResource\Output\Chat;

/**
 * A file the user asked for: which message (`messageId`, the id the upload and the failure name), in which chat, by its
 * WhatsApp id, and what the bridge's store said of it (`kind`, `size` in bytes, null when unknown). The relay refuses a
 * file larger than `maxBytes` before it downloads anything.
 */
final readonly class RelayMediaClaimOutput
{
    public function __construct(
        public string $messageId,
        public string $chatJid,
        public string $waId,
        public string $kind,
        public ?int $size,
        public int $maxBytes,
    ) {
    }
}
