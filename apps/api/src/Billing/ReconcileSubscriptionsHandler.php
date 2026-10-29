<?php

declare(strict_types=1);

namespace App\Billing;

use Psr\Log\LoggerInterface;
use Symfony\Component\Messenger\Attribute\AsMessageHandler;

#[AsMessageHandler]
final readonly class ReconcileSubscriptionsHandler
{
    public function __construct(
        private BillingSettings $settings,
        private Subscriptions $subscriptions,
        private LoggerInterface $logger,
    ) {
    }

    public function __invoke(ReconcileSubscriptions $message): void
    {
        if (!$this->settings->enabled) {
            return;
        }

        $result = $this->subscriptions->reconcile();
        $this->logger->info('Followed {followed} subscriptions at Stripe, {failed} could not be asked.', $result);
    }
}
