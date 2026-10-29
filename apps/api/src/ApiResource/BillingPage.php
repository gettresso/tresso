<?php

declare(strict_types=1);

namespace App\ApiResource;

/**
 * A Stripe page to open in the browser: Checkout to pay, or the billing portal to manage the subscription.
 */
final readonly class BillingPage
{
    public function __construct(public string $url)
    {
    }
}
