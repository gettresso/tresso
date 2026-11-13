<?php

declare(strict_types=1);

namespace App\Chat;

use Symfony\Component\DependencyInjection\Attribute\Autowire;

/**
 * How large one WhatsApp file may be (`CHAT_MAX_FILE_BYTES`, 100 MB by default): a file the relaying Mac brings for the
 * user's other devices, and a file a browser or phone attaches to a reply. The Mac sends at most 100 MB through the
 * bridge, so a larger default would only store files that cannot go out.
 */
final readonly class ChatMediaLimits
{
    public function __construct(
        #[Autowire(env: 'int:CHAT_MAX_FILE_BYTES')]
        public int $maxFileBytes,
    ) {
        if ($maxFileBytes < 1) {
            throw new \InvalidArgumentException('CHAT_MAX_FILE_BYTES must be a positive number of bytes.');
        }
    }
}
