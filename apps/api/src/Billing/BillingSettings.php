<?php

declare(strict_types=1);

namespace App\Billing;

use Symfony\Component\DependencyInjection\Attribute\Autowire;

/**
 * Whether this server bills its organizations, and with which Stripe prices. Off unless TRESSO_BILLING is 1: a
 * self-hosted server never bills and never blocks anyone. Tresso Cloud turns it on.
 */
final readonly class BillingSettings
{
    public const int TRIAL_DAYS = 14;

    public function __construct(
        #[Autowire(env: 'bool:TRESSO_BILLING')]
        public bool $enabled,
        #[Autowire(env: 'STRIPE_PRICE_MONTHLY')]
        private string $monthlyPrice,
        #[Autowire(env: 'STRIPE_PRICE_YEARLY')]
        private string $yearlyPrice,
    ) {
    }

    /**
     * The Stripe price of each plan this server sells; a plan without a price is not offered.
     *
     * @return array<string, string> plan => price id
     */
    public function prices(): array
    {
        return array_filter(['monthly' => trim($this->monthlyPrice), 'yearly' => trim($this->yearlyPrice)], static fn (string $price): bool => '' !== $price);
    }
}
