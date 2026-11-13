<?php

declare(strict_types=1);

namespace App\Chat;

/** A WhatsApp file that a message, reply or upload stopped referring to: removed if nothing refers to it now. */
final readonly class CollectChatMedia
{
    public function __construct(public string $objectKey)
    {
    }
}
