<?php

declare(strict_types=1);

namespace App\Billing\Stripe;

use App\Billing\SubscriptionStatus;

/**
 * A subscription as Stripe has it now.
 */
final readonly class StripeSubscription
{
    public function __construct(
        public string $id,
        public string $customerId,
        public SubscriptionStatus $status,
        public int $quantity,
        public ?\DateTimeImmutable $currentPeriodEnd,
        /** The organization the checkout was for, from the subscription's metadata. */
        public ?string $organizationId,
    ) {
    }

    /**
     * @param array<mixed> $object a Stripe subscription object
     */
    public static function fromApi(array $object): self
    {
        $id = $object['id'] ?? null;
        $customer = $object['customer'] ?? null;
        $customer = \is_array($customer) ? ($customer['id'] ?? null) : $customer;
        $status = SubscriptionStatus::tryFrom(\is_string($object['status'] ?? null) ? $object['status'] : '');
        if (!\is_string($id) || !\is_string($customer) || null === $status || SubscriptionStatus::Trial === $status) {
            throw new StripeException('Stripe sent a subscription without an id, a customer or a known status.');
        }

        $item = \is_array($object['items'] ?? null) && \is_array($object['items']['data'] ?? null) ? ($object['items']['data'][0] ?? []) : [];
        $item = \is_array($item) ? $item : [];
        $quantity = $item['quantity'] ?? 0;
        // Since API version 2025-03-31 the billing period is on each item; older versions keep it on the subscription.
        $periodEnd = $item['current_period_end'] ?? $object['current_period_end'] ?? null;
        $metadata = \is_array($object['metadata'] ?? null) ? $object['metadata'] : [];
        $organization = $metadata['organization_id'] ?? null;

        return new self(
            $id,
            $customer,
            $status,
            \is_int($quantity) ? $quantity : 0,
            \is_int($periodEnd) ? new \DateTimeImmutable('@'.$periodEnd) : null,
            \is_string($organization) && '' !== $organization ? $organization : null,
        );
    }
}
