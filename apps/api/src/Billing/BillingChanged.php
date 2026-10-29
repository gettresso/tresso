<?php

declare(strict_types=1);

namespace App\Billing;

/**
 * Something else changed the organization's billing while this request waited for it, such as its Stripe customer
 * being deleted; the request can simply be made again.
 */
final class BillingChanged extends \RuntimeException
{
}
