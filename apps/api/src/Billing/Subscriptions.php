<?php

declare(strict_types=1);

namespace App\Billing;

use App\Billing\Stripe\StripeClient;
use App\Billing\Stripe\StripeException;
use App\Billing\Stripe\StripeSubscription;
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
        'customer.deleted',
    ];

    /** Stripe retries an event for three days; handled ids are kept a while longer, then removed. */
    public const string KEEP_EVENTS = '30 days';

    public function __construct(
        private EntityManagerInterface $entityManager,
        private StripeClient $stripe,
        private OrganizationMemberRepository $members,
        private ClockInterface $clock,
        #[Autowire(env: 'WEB_APP_URL')]
        private string $webAppUrl,
    ) {
    }

    /**
     * Every organization starts with a free trial, so a new account works at once and without a card. Whatever makes
     * an organization calls this, in the same flush: an organization without a subscription gives no access.
     */
    public function startTrial(Organization $organization): Subscription
    {
        $now = $this->now();
        $subscription = new Subscription($organization, $now->modify('+'.BillingSettings::TRIAL_DAYS.' days'), $now);
        $this->entityManager->persist($subscription);

        return $subscription;
    }

    public function of(Organization $organization): Subscription
    {
        $subscription = $this->entityManager->getRepository(Subscription::class)->findOneBy(['organization' => $organization]);
        if (null === $subscription) {
            throw new \LogicException(\sprintf('Organization %s has no subscription; it should have started its trial when it was made.', $organization->getId()->toRfc4122()));
        }

        return $subscription;
    }

    /**
     * Gives every organization still in its own trial (nothing at Stripe) 14 days from now. Run once when a server
     * turns billing on, so organizations made while it did not bill are not blocked at once.
     */
    public function restartTrials(): int
    {
        $now = $this->now();
        $restarted = 0;
        foreach ($this->entityManager->getRepository(Subscription::class)->findBy(['stripeSubscriptionId' => null]) as $subscription) {
            $subscription->restartTrial($now->modify('+'.BillingSettings::TRIAL_DAYS.' days'), $now);
            ++$restarted;
        }
        $this->entityManager->flush();

        return $restarted;
    }

    /**
     * The Checkout page for the plan's price, for every member of the organization. Refused while the organization has
     * a subscription that is not over, here or at Stripe (one whose events have not arrived yet included): a second
     * one would charge twice. Two admins at once wait for each other.
     *
     * @throws OpenSubscription
     * @throws BillingChanged
     */
    public function checkout(Subscription $subscription, User $payer, string $priceId): string
    {
        $customer = $this->customer($subscription, $payer);

        // null: refused, after taking over the open subscription found at Stripe (committed, not rolled back).
        $url = $this->entityManager->wrapInTransaction(function () use ($subscription, $customer, $priceId): ?string {
            $this->lock($subscription);
            // A customer.deleted that came in meanwhile leaves none: the next attempt makes a new one.
            if ($subscription->getStripeCustomerId() !== $customer) {
                throw new BillingChanged('The organization\'s billing changed meanwhile; try again.');
            }
            if ($subscription->hasOpenSubscription()) {
                return null;
            }
            foreach ($this->stripe->subscriptionsOf($customer) as $existing) {
                if (!\in_array($existing->status, [SubscriptionStatus::Canceled, SubscriptionStatus::IncompleteExpired], true)) {
                    $this->take($subscription, $existing);

                    return null;
                }
            }

            $organization = $subscription->getOrganization();
            $base = rtrim($this->webAppUrl, '/').'/settings/billing';

            return $this->stripe->createCheckoutSession(
                $customer,
                $organization->getId()->toRfc4122(),
                $priceId,
                max(1, $this->members->countPerOrganization([$organization->getId()])[$organization->getId()->toRfc4122()] ?? 1),
                $base.'?checkout=done',
                $base.'?checkout=cancelled',
            );
        });
        if (null === $url) {
            throw new OpenSubscription();
        }

        return $url;
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
                ['id' => mb_substr($event->id, 0, 255), 'type' => mb_substr($event->type, 0, 120), 'now' => $this->now()->format('Y-m-d H:i:s')],
            );
            if (0 === $inserted) {
                return false;
            }

            if ('customer.deleted' === $event->type && \is_string($event->object['id'] ?? null)) {
                $this->forgetCustomer($event->object['id']);

                return true;
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
     * its metadata names, else the one with its customer; a subscription of nobody here is left alone. The row is
     * locked before Stripe is asked (again), so of two events handled at once the later one stores the later answer.
     */
    public function follow(string $stripeSubscriptionId): ?Subscription
    {
        $repository = $this->entityManager->getRepository(Subscription::class);
        $subscription = $repository->findOneBy(['stripeSubscriptionId' => $stripeSubscriptionId]);
        if (null === $subscription) {
            $stripe = $this->stripe->subscription($stripeSubscriptionId);
            if (null !== $stripe->organizationId && Uuid::isValid($stripe->organizationId)) {
                $subscription = $repository->findOneBy(['organization' => Uuid::fromString($stripe->organizationId)]);
            }
            $subscription ??= $repository->findOneBy(['stripeCustomerId' => $stripe->customerId]);
        }
        if (null === $subscription) {
            return null;
        }

        $this->lock($subscription);
        $this->take($subscription, $this->stripe->subscription($stripeSubscriptionId));

        return $subscription;
    }

    /**
     * The nightly check, should webhooks have been lost: every organization with a Stripe customer takes over the
     * best of its subscriptions there (one that pays, then the one it follows, then the newest), which also finds a
     * first checkout whose events never arrived. Handled event ids older than a month are removed.
     *
     * @return array{followed: int, failed: int}
     */
    public function reconcile(): array
    {
        /** @var list<string> $ids */
        $ids = $this->entityManager->getConnection()->fetchFirstColumn('SELECT id FROM billing_subscription WHERE stripe_customer_id IS NOT NULL ORDER BY id');
        $followed = 0;
        $failed = 0;
        foreach ($ids as $id) {
            $subscription = $this->entityManager->find(Subscription::class, Uuid::fromString($id));
            if (null === $subscription) {
                continue;
            }
            // A transaction per organization that keeps the entity manager open when Stripe fails, so the next one
            // is still checked (wrapInTransaction would close it). The customer is read after the lock.
            $connection = $this->entityManager->getConnection();
            $connection->beginTransaction();
            try {
                $this->lock($subscription);
                $customer = $subscription->getStripeCustomerId();
                if (null !== $customer) {
                    $this->reconcileCustomer($subscription, $customer);
                    ++$followed;
                }
                $connection->commit();
            } catch (StripeException) {
                $connection->rollBack();
                // Also a customer Stripe says it does not have: a wrong key or account says the same, so only Stripe's
                // customer.deleted event forgets one.
                ++$failed;
            } catch (\Throwable $exception) {
                // Never leave the transaction open in the long-running worker that runs this.
                $connection->rollBack();

                throw $exception;
            }
            $this->entityManager->clear();
        }

        $this->entityManager->getConnection()->executeStatement(
            'DELETE FROM billing_stripe_event WHERE received_at < :before',
            ['before' => $this->now()->modify('-'.self::KEEP_EVENTS)->format('Y-m-d H:i:s')],
        );

        return ['followed' => $followed, 'failed' => $failed];
    }

    private function reconcileCustomer(Subscription $subscription, string $customer): void
    {
        $candidates = $this->stripe->subscriptionsOf($customer);
        usort($candidates, static fn (StripeSubscription $a, StripeSubscription $b): int => [
            \in_array($b->status, SubscriptionStatus::PAYING, true), $b->id === $subscription->getStripeSubscriptionId(),
        ] <=> [
            \in_array($a->status, SubscriptionStatus::PAYING, true), $a->id === $subscription->getStripeSubscriptionId(),
        ]);
        if ([] !== $candidates) {
            $this->take($subscription, $candidates[0]);
        }
    }

    private function take(Subscription $subscription, StripeSubscription $stripe): void
    {
        $subscription->follow($stripe, $this->now());
        $this->entityManager->flush();
    }

    private function forgetCustomer(string $customerId): void
    {
        $subscription = $this->entityManager->getRepository(Subscription::class)->findOneBy(['stripeCustomerId' => $customerId]);
        if (null !== $subscription) {
            $this->lock($subscription);
            if ($subscription->getStripeCustomerId() === $customerId) {
                $subscription->forgetCustomer($this->now());
                $this->entityManager->flush();
            }
        }
    }

    /** In UTC, as every time is stored. */
    private function now(): \DateTimeImmutable
    {
        return $this->clock->now()->setTimezone(new \DateTimeZone('UTC'));
    }

    /** The organization's Stripe customer, made once: two admins at once wait for each other and share it. */
    private function customer(Subscription $subscription, User $payer): string
    {
        if (null !== $subscription->getStripeCustomerId()) {
            return $subscription->getStripeCustomerId();
        }

        return $this->entityManager->wrapInTransaction(function () use ($subscription, $payer): string {
            $this->lock($subscription);
            $customer = $subscription->getStripeCustomerId();
            if (null === $customer) {
                $organization = $subscription->getOrganization();
                // The key changes once a deleted customer is forgotten, so Stripe never hands that one back.
                $customer = $this->stripe->createCustomer($organization->getId()->toRfc4122(), $organization->getName(), $payer->getEmail(), $subscription->getUpdatedAt()->format('U'));
                $subscription->linkCustomer($customer, $this->now());
                $this->entityManager->flush();
            }

            return $customer;
        });
    }

    /**
     * Locks the row until the transaction ends and reads it again, so decisions and the flush start from what the
     * transaction that held the lock before committed. Only inside a transaction.
     */
    private function lock(Subscription $subscription): void
    {
        if (!$this->entityManager->getConnection()->isTransactionActive()) {
            throw new \LogicException('A subscription is only locked inside a transaction.');
        }
        $this->entityManager->getConnection()->executeQuery('SELECT id FROM billing_subscription WHERE id = :id FOR UPDATE', ['id' => $subscription->getId()->toRfc4122()]);
        $this->entityManager->refresh($subscription);
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
