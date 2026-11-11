<?php

declare(strict_types=1);

namespace App\Bulk;

/** Every few minutes: pick up bulk actions under way whose queue message got lost. */
final readonly class SweepBulkActions
{
}
