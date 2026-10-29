<?php

declare(strict_types=1);

namespace App\Billing;

/**
 * Asks Stripe again for every subscription, nightly, in case a webhook was lost.
 */
final readonly class ReconcileSubscriptions
{
}
