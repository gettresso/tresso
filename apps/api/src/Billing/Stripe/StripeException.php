<?php

declare(strict_types=1);

namespace App\Billing\Stripe;

/**
 * Stripe could not be reached, refused a request, or answered with something unexpected. The message never contains
 * a key.
 */
final class StripeException extends \RuntimeException
{
}
