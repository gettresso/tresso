<?php

declare(strict_types=1);

namespace App\ApiResource\Output\Chat;

/** Where a file the relay was asked for stands now: `stored`, or `failed` with its error. */
final readonly class RelayMediaOutput
{
    public function __construct(
        public string $messageId,
        public string $state,
        public ?string $error,
    ) {
    }
}
