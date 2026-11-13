<?php

declare(strict_types=1);

namespace App\Chat;

use Psr\Clock\ClockInterface;
use Symfony\Component\Messenger\Attribute\AsMessageHandler;

/**
 * Runs every ten minutes on the `scheduler_default` transport (the `maintenance` worker): uploads no reply took within
 * {@see ChatUploads::KEEP_UNQUEUED} go, with their files once nothing else refers to them.
 */
#[AsMessageHandler]
final readonly class SweepChatMediaHandler
{
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
    }
}
