<?php

declare(strict_types=1);

namespace App\Sync\Calendar;

/**
 * Every minute: a meeting request still pending {@see CalendarSynchronizer::STALE_REQUEST} after it was asked for, with no
 * write of its event waiting, has failed.
 */
final readonly class SweepMeetingRequests
{
}
