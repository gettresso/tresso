<?php

declare(strict_types=1);

namespace App\Billing;

use App\Billing\Stripe\StripeClient;
use App\Billing\Stripe\StripeException;
use App\Billing\Stripe\WebhookEvent;
use App\Entity\Organization;
use App\Entity\Subscription;
use App\Entity\User;
use App\Repository\OrganizationMemberRepository;
use Doctrine\ORM\EntityManagerInterface;
use Psr\Clock\ClockInterface;
use Symfony\Component\DependencyInjection\Attribute\Autowire;
use Symfony\Component\Uid\Uuid;

/**
 * Starts an organization's trial, sends its owners to Stripe to pay or manage, and follows what Stripe reports.
 */
final readonly class Subscriptions
{
    /** The events that can change a subscription; others are acknowledged and ignored. */
    public const array EVENTS = [
        'checkout.session.completed',
        'customer.subscription.created',
        'customer.subscription.updated',
        'customer.subscription.deleted',
        'customer.subscription.paused',
        'customer.subscription.resumed',
        'invoice.paid',
        'invoice.payment_failed',
    ];

    public function __construct(
        private EntityManagerInterface $entityManager,
        private StripeClient $stripe,
        private OrganizationMemberRepository $members,
        private ClockInterface $clock,
        #[Autowire(env: 'WEB_APP_URL')]
        private string $webAppUrl,
    ) {
    }

    /** Every organization starts with a free trial, so a new account works at once and without a card. */
    public function startTrial(Organization $organization): Subscription
    {
        $now = $this->clock->now();
        $subscription = new Subscription($organization, $now->modify('+'.BillingSettings::TRIAL_DAYS.' days'), $now);
        $this->entityManager->persist($subscription);

        return $subscription;
    }

    /** The organization's subscription; one made before billing existed gets its trial now. */
    public function of(Organization $organization): Subscription
    {
        $subscription = $this->entityManager->getRepository(Subscription::class)->findOneBy(['organization' => $organization]);
        if (null === $subscription) {
            $subscription = $this->startTrial($organization);
            $this->entityManager->flush();
        }

        return $subscription;
    }

    /** The Checkout page for the plan's price, for every member of the organization. */
    public function checkout(Subscription $subscription, User $payer, string $priceId): string
    {
        $organization = $subscription->getOrganization();
        $base = rtrim($this->webAppUrl, '/').'/settings/billing';

        return $this->stripe->createCheckoutSession(
            $this->customer($subscription, $payer),
            $organization->getId()->toRfc4122(),
            $priceId,
            max(1, $this->members->countPerOrganization([$organization->getId()])[$organization->getId()->toRfc4122()] ?? 1),
            $base.'?checkout=done',
            $base.'?checkout=cancelled',
        );
    }

    public function portal(Subscription $subscription, User $payer): string
    {
        return $this->stripe->createPortalSession($this->customer($subscription, $payer), rtrim($this->webAppUrl, '/').'/settings/billing');
    }

    /** Handles a verified webhook event once: a repeated event id changes nothing. Returns false for a repeat. */
    public function handle(WebhookEvent $event): bool
    {
        return $this->entityManager->wrapInTransaction(function () use ($event): bool {
            $inserted = $this->entityManager->getConnection()->executeStatement(
                'INSERT INTO billing_stripe_event (id, type, received_at) VALUES (:id, :type, :now) ON CONFLICT (id) DO NOTHING',
                ['id' => mb_substr($event->id, 0, 255), 'type' => mb_substr($event->type, 0, 120), 'now' => $this->clock->now()->format('Y-m-d H:i:s')],
            );
            if (0 === $inserted) {
                return false;
            }

            $subscriptionId = \in_array($event->type, self::EVENTS, true) ? self::subscriptionOf($event) : null;
            if (null !== $subscriptionId) {
                $this->follow($subscriptionId);
            }

            return true;
        });
    }

    /**
     * Takes over a subscription as Stripe has it now. It belongs to the organization that already has it, else the one
     * its metadata names, else the one with its customer; a subscription of nobody here is left alone.
     */
    public function follow(string $stripeSubscriptionId): ?Subscription
    {
        $stripe = $this->stripe->subscription($stripeSubscriptionId);
        $repository = $this->entityManager->getRepository(Subscription::class);
        $subscription = $repository->findOneBy(['stripeSubscriptionId' => $stripe->id]);
        if (null === $subscription && null !== $stripe->organizationId && Uuid::isValid($stripe->organizationId)) {
            $subscription = $repository->findOneBy(['organization' => Uuid::fromString($stripe->organizationId)]);
        }
        $subscription ??= $repository->findOneBy(['stripeCustomerId' => $stripe->customerId]);
        if (null === $subscription) {
            return null;
        }

        $subscription->follow($stripe, $this->clock->now());
        $this->entityManager->flush();

        return $subscription;
    }

    /**
     * Follows every subscription that Stripe knows again: the nightly check, should a webhook have been lost.
     *
     * @return array{followed: int, failed: int}
     */
    public function reconcile(): array
    {
        /** @var list<string> $ids */
        $ids = $this->entityManager->getConnection()->fetchFirstColumn('SELECT stripe_subscription_id FROM billing_subscription WHERE stripe_subscription_id IS NOT NULL ORDER BY id');
        $followed = 0;
        $failed = 0;
        foreach ($ids as $id) {
            try {
                $this->follow($id);
                ++$followed;
            } catch (StripeException) {
                ++$failed;
            }
            $this->entityManager->clear();
        }

        return ['followed' => $followed, 'failed' => $failed];
    }

    private function customer(Subscription $subscription, User $payer): string
    {
        $customer = $subscription->getStripeCustomerId();
        if (null !== $customer) {
            return $customer;
        }

        $organization = $subscription->getOrganization();
        $customer = $this->stripe->createCustomer($organization->getId()->toRfc4122(), $organization->getName(), $payer->getEmail());
        $subscription->linkCustomer($customer, $this->clock->now());
        $this->entityManager->flush();

        return $customer;
    }

    /**
     * The subscription an event is about: the object itself, a finished Checkout's, or an invoice's (whose place
     * moved under `parent` in API version 2025-03-31).
     */
    private static function subscriptionOf(WebhookEvent $event): ?string
    {
        $object = $event->object;
        $type = $event->type;
        $candidates = match (true) {
            str_starts_with($type, 'customer.subscription.') => [$object['id'] ?? null],
            'checkout.session.completed' === $type => [$object['subscription'] ?? null],
            default => [
                $object['subscription'] ?? null,
                \is_array($object['parent'] ?? null) && \is_array($object['parent']['subscription_details'] ?? null) ? ($object['parent']['subscription_details']['subscription'] ?? null) : null,
            ],
        };
        foreach ($candidates as $candidate) {
            $candidate = \is_array($candidate) ? ($candidate['id'] ?? null) : $candidate;
            if (\is_string($candidate) && str_starts_with($candidate, 'sub_')) {
                return $candidate;
            }
        }

        return null;
    }
}
