<?php

declare(strict_types=1);

namespace App\Entity;

use Doctrine\ORM\Mapping as ORM;

/**
 * A Stripe webhook event that was handled. Stripe delivers an event at least once, so its id is kept to answer a
 * repeat without handling it twice.
 */
#[ORM\Entity]
#[ORM\Table(name: 'billing_stripe_event')]
#[ORM\Index(columns: ['received_at'])]
class StripeEvent
{
    public function __construct(
        #[ORM\Id]
        #[ORM\Column(length: 255)]
        private string $id,
        #[ORM\Column(length: 120)]
        private string $type,
        #[ORM\Column]
        private \DateTimeImmutable $receivedAt,
    ) {
    }

    public function getId(): string
    {
        return $this->id;
    }

    public function getType(): string
    {
        return $this->type;
    }

    public function getReceivedAt(): \DateTimeImmutable
    {
        return $this->receivedAt;
    }
}
