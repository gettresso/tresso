<?php

declare(strict_types=1);

namespace App\Command;

use App\Billing\BillingSettings;
use App\Billing\Subscriptions;
use Symfony\Component\Console\Attribute\AsCommand;
use Symfony\Component\Console\Command\Command;
use Symfony\Component\Console\Style\SymfonyStyle;

/**
 * Takes every subscription over from Stripe again, as the nightly check does, for example after a webhook outage.
 */
#[AsCommand(name: 'app:billing:reconcile', description: 'Ask Stripe again for every subscription')]
final readonly class ReconcileSubscriptionsCommand
{
    public function __construct(
        private BillingSettings $settings,
        private Subscriptions $subscriptions,
    ) {
    }

    public function __invoke(SymfonyStyle $io): int
    {
        if (!$this->settings->enabled) {
            $io->note('This server does not bill (TRESSO_BILLING is off).');

            return Command::SUCCESS;
        }

        $result = $this->subscriptions->reconcile();
        $io->success(\sprintf('Followed %d subscriptions; %d could not be asked.', $result['followed'], $result['failed']));

        return 0 === $result['failed'] ? Command::SUCCESS : Command::FAILURE;
    }
}
