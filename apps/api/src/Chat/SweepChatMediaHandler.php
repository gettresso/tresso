<?php

declare(strict_types=1);

namespace App\Chat;

use Psr\Clock\ClockInterface;
use Symfony\Component\Messenger\Attribute\AsMessageHandler;

/**
 * Runs every ten minutes on the `scheduler_default` transport (the `maintenance` worker): uploads no reply took within
 * {@see ChatUploads::KEEP_UNQUEUED} go, with their files once nothing else refers to them, and so do temporary files of
 * uploads ({@see ChatFileBody}) older than {@see TEMPORARY_FOR} that a killed worker left behind.
 */
#[AsMessageHandler]
final readonly class SweepChatMediaHandler
{
    /** A request with a file ends long before this, worked or not. */
    public const int TEMPORARY_FOR = 3600;

    public function __construct(
        private ChatUploads $uploads,
        private ClockInterface $clock,
    ) {
    }

    public function __invoke(SweepChatMedia $message): void
    {
        $now = $this->clock->now()->setTimezone(new \DateTimeZone(date_default_timezone_get()));
        // A batch at a time; what is left comes on the next run.
        $this->uploads->sweep($now);
        self::sweepTemporary(sys_get_temp_dir(), $now->getTimestamp() - self::TEMPORARY_FOR);
    }

    /** Removes temporary upload files in $dir last written before $before (epoch seconds). Returns how many went. */
    public static function sweepTemporary(string $dir, int $before): int
    {
        $removed = 0;
        foreach (glob(rtrim($dir, '/').'/'.ChatFileBody::TEMPORARY_PREFIX.'*') ?: [] as $path) {
            $written = @filemtime($path);
            if (is_file($path) && false !== $written && $written < $before && @unlink($path)) {
                ++$removed;
            }
        }

        return $removed;
    }
}
