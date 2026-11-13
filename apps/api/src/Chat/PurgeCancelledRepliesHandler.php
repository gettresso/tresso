<?php

declare(strict_types=1);

namespace App\Chat;

use Psr\Clock\ClockInterface;
use Symfony\Component\Messenger\Attribute\AsMessageHandler;

/**
 * Runs once a day on the `scheduler_default` transport (the `maintenance` worker): replies cancelled while their sending
 * was unconfirmed go {@see ChatQueue::KEEP_CANCELLED} after their claim. Once a day, since nothing indexes those rows
 * and a day more or less does not matter after 30.
 */
#[AsMessageHandler]
final readonly class PurgeCancelledRepliesHandler
{
    public function __construct(
        private ChatQueue $queue,
        private ClockInterface $clock,
    ) {
    }

    public function __invoke(PurgeCancelledReplies $message): int
    {
        // A batch at a time; what is left comes the next day.
        return $this->queue->purgeCancelled($this->clock->now()->setTimezone(new \DateTimeZone(date_default_timezone_get())));
    }
}
