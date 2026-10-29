<?php

declare(strict_types=1);

namespace App\Entity;

use App\Billing\Stripe\StripeSubscription;
use App\Billing\SubscriptionStatus;
use Doctrine\ORM\Mapping as ORM;
use Symfony\Bridge\Doctrine\Types\UuidType;
use Symfony\Component\Uid\Uuid;

/**
 * What an organization pays on a server that bills (TRESSO_BILLING): a free trial from the start, then a Stripe
 * subscription for its members. Stripe is the source of truth; this copy follows its webhooks and a nightly check.
 */
#[ORM\Entity]
#[ORM\Table(name: 'billing_subscription')]
class Subscription
{
    #[ORM\Id]
    #[ORM\Column(type: UuidType::NAME)]
    private Uuid $id;

    #[ORM\OneToOne]
    #[ORM\JoinColumn(nullable: false, unique: true, onDelete: 'CASCADE')]
    private Organization $organization;

    #[ORM\Column(length: 24, enumType: SubscriptionStatus::class)]
    private SubscriptionStatus $status = SubscriptionStatus::Trial;

    #[ORM\Column]
    private \DateTimeImmutable $trialEndsAt;

    #[ORM\Column(length: 255, unique: true, nullable: true)]
    private ?string $stripeCustomerId = null;

    #[ORM\Column(length: 255, unique: true, nullable: true)]
    private ?string $stripeSubscriptionId = null;

    /** Members paid for, as Stripe last reported it; 0 before a subscription exists. */
    #[ORM\Column(options: ['default' => 0])]
    private int $seats = 0;

    #[ORM\Column(nullable: true)]
    private ?\DateTimeImmutable $currentPeriodEnd = null;

    #[ORM\Column]
    private \DateTimeImmutable $updatedAt;

    public function __construct(Organization $organization, \DateTimeImmutable $trialEndsAt, \DateTimeImmutable $now)
    {
        $this->id = Uuid::v7();
        $this->organization = $organization;
        $this->trialEndsAt = $trialEndsAt;
        $this->updatedAt = $now;
    }

    public function getId(): Uuid
    {
        return $this->id;
    }

    public function getOrganization(): Organization
    {
        return $this->organization;
    }

    public function getStatus(): SubscriptionStatus
    {
        return $this->status;
    }

    public function getTrialEndsAt(): \DateTimeImmutable
    {
        return $this->trialEndsAt;
    }

    public function getStripeCustomerId(): ?string
    {
        return $this->stripeCustomerId;
    }

    public function getStripeSubscriptionId(): ?string
    {
        return $this->stripeSubscriptionId;
    }

    public function getSeats(): int
    {
        return $this->seats;
    }

    public function getCurrentPeriodEnd(): ?\DateTimeImmutable
    {
        return $this->currentPeriodEnd;
    }

    /** The same rule as {@see \App\Billing\Entitlements}, which asks the database. */
    public function allowsAccessAt(\DateTimeImmutable $now): bool
    {
        return SubscriptionStatus::Trial === $this->status ? $now < $this->trialEndsAt : \in_array($this->status, SubscriptionStatus::PAYING, true);
    }

    public function linkCustomer(string $customerId, \DateTimeImmutable $now): void
    {
        $this->stripeCustomerId = $customerId;
        $this->updatedAt = $now;
    }

    /** Takes over the subscription as Stripe has it now, whatever order its events came in. */
    public function follow(StripeSubscription $subscription, \DateTimeImmutable $now): void
    {
        $this->stripeSubscriptionId = $subscription->id;
        $this->stripeCustomerId = $subscription->customerId;
        $this->status = $subscription->status;
        $this->seats = $subscription->quantity;
        $this->currentPeriodEnd = $subscription->currentPeriodEnd;
        $this->updatedAt = $now;
    }
}
