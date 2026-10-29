<?php

declare(strict_types=1);

namespace App\Billing;

/**
 * The organization already has a subscription that is not over; a new checkout would add a second one.
 */
final class OpenSubscription extends \RuntimeException
{
    public function __construct()
    {
        parent::__construct('This organization already has a subscription; manage it in the billing portal.');
    }
}
