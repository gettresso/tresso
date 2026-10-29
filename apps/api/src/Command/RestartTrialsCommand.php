<?php

declare(strict_types=1);

namespace App\Command;

use App\Billing\BillingSettings;
use App\Billing\Subscriptions;
use Symfony\Component\Console\Attribute\AsCommand;
use Symfony\Component\Console\Command\Command;
use Symfony\Component\Console\Style\SymfonyStyle;

/**
 * Run once when a server turns billing on: organizations made while it did not bill get their 14 days from now,
 * instead of being blocked at once because their trial ran out unnoticed.
 */
#[AsCommand(name: 'app:billing:restart-trials', description: 'Give every organization without a Stripe subscription a new trial from now')]
final readonly class RestartTrialsCommand
{
    public function __construct(
        private BillingSettings $settings,
        private Subscriptions $subscriptions,
    ) {
    }

    public function __invoke(SymfonyStyle $io): int
    {
        if (!$this->settings->enabled) {
            $io->error('This server does not bill (TRESSO_BILLING is off); turn billing on first.');

            return Command::FAILURE;
        }

        $io->success(\sprintf('%d organizations have a new trial of %d days.', $this->subscriptions->restartTrials(), BillingSettings::TRIAL_DAYS));

        return Command::SUCCESS;
    }
}
