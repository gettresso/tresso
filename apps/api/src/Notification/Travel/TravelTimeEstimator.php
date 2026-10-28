<?php

declare(strict_types=1);

namespace App\Notification\Travel;

use App\Enum\TravelMode;

/**
 * How long it takes to get from a position to a place, for leave-now reminders. Tresso routes with self-hosted
 * OSRM servers and a Nominatim geocoder when they are configured; another estimator may be added.
 */
interface TravelTimeEstimator
{
    public function isAvailable(TravelMode $mode): bool;

    /**
     * Minutes from the position to the place, or null when the place cannot be found or reached that way. The
     * position is only used for this one estimate.
     */
    public function minutes(float $latitude, float $longitude, string $place, \DateTimeImmutable $arriveBy, TravelMode $mode): ?int;
}
