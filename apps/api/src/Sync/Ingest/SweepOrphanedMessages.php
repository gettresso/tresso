<?php

declare(strict_types=1);

namespace App\Sync\Ingest;

/** Every few minutes: delete messages that have been in no folder for longer than {@see MessageJanitor::GRACE}. */
final readonly class SweepOrphanedMessages
{
}
