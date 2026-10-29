<?php

declare(strict_types=1);

namespace App\Billing;

/**
 * Where an organization's subscription stands. `trial` is Tresso's own free start, without a card or anything at
 * Stripe; every other value is the status Stripe reports for the subscription.
 */
enum SubscriptionStatus: string
{
    case Trial = 'trial';
    case Trialing = 'trialing';
    case Active = 'active';
    // A payment failed and Stripe is retrying it: access stays until Stripe gives up.
    case PastDue = 'past_due';
    case Unpaid = 'unpaid';
    case Canceled = 'canceled';
    case Incomplete = 'incomplete';
    case IncompleteExpired = 'incomplete_expired';
    case Paused = 'paused';

    /** The statuses that give access without looking at a date; `trial` gives access until it ends. */
    public const array PAYING = [self::Trialing, self::Active, self::PastDue];

    /** @return list<string> */
    public static function payingValues(): array
    {
        return array_map(static fn (self $status): string => $status->value, self::PAYING);
    }
}
