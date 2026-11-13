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
    /** What the relaying Mac reads and sends through the bridge at most (`MAX_SEND_BYTES` in the desktop shell). */
    public const int MAC_MAX_BYTES = 100 * 1024 * 1024;

    public function __construct(
        #[Autowire(env: 'int:CHAT_MAX_FILE_BYTES')]
        public int $maxFileBytes,
    ) {
        self::check($maxFileBytes);
    }

    /**
     * Refuses a setting the app cannot work with; run as the kernel boots ({@see \App\Kernel::boot()}), so the app does
     * not start with one. Above what the Mac reads, a file the server would take is one the Mac can never bring or send.
     *
     * @param mixed $value the setting as the environment holds it (null when it is not set: the default applies)
     */
    public static function check(mixed $value): void
    {
        if (null === $value) {
            return;
        }
        $bytes = \is_int($value) ? $value : (\is_string($value) && 1 === preg_match('/^[0-9]+$/', $value) ? (int) $value : null);
        if (null === $bytes || $bytes < 1 || $bytes > self::MAC_MAX_BYTES) {
            throw new \InvalidArgumentException(\sprintf('CHAT_MAX_FILE_BYTES must be a whole number of bytes from 1 to %d (what the Mac sends).', self::MAC_MAX_BYTES));
        }
    }
}
