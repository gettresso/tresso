<?php

declare(strict_types=1);

namespace App\ApiResource;

/**
 * Where one organization's subscription stands, inside {@see BillingResource}.
 */
final readonly class BillingOrganization
{
    public function __construct(
        public string $id,
        public string $name,
        public bool $personal,
        /** `trial` (free, until `trialEndsAt`), or Stripe's status: `trialing`, `active`, `past_due`, `unpaid`, `canceled`, `incomplete`, `incomplete_expired`, `paused`. */
        public string $status,
        /** Whether this organization gives its members access now. */
        public bool $entitled,
        public \DateTimeImmutable $trialEndsAt,
        public ?\DateTimeImmutable $currentPeriodEnd,
        /** Members paid for, as Stripe reports it; 0 before a subscription. */
        public int $seats,
        /** Whether the user may pay for it or manage its subscription: owners and admins. */
        public bool $canManage,
    ) {
    }
}
