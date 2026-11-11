<?php

declare(strict_types=1);

namespace App\Mail\Check;

/**
 * The outcome of checking a mail account's servers before it is created.
 */
final readonly class ConnectionCheck
{
    public function __construct(
        public CheckStatus $imap,
        public CheckStatus $smtp,
        /** Folders the IMAP server listed; null when signing in failed. */
        public ?int $folders,
        /** One technical line about what failed (host and port, or what the server said); null when all went well. */
        public ?string $detail,
    ) {
    }

    public function passed(): bool
    {
        return CheckStatus::Ok === $this->imap && CheckStatus::Ok === $this->smtp;
    }
}
