<?php

declare(strict_types=1);

namespace App\Billing\Stripe;

/**
 * A Stripe webhook event whose signature was checked.
 */
final readonly class WebhookEvent
{
    /**
     * @param array<mixed> $object the event's data.object
     */
    public function __construct(
        public string $id,
        public string $type,
        public array $object,
    ) {
    }
}
