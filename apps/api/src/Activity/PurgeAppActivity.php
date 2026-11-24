<?php

declare(strict_types=1);

namespace App\Activity;

/**
 * Removes entries of the activity log older than {@see \App\Entity\AppActivity::KEEP_FOR}. Sent by the schedule once a
 * day.
 */
final readonly class PurgeAppActivity
{
}
