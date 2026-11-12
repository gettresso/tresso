<?php

declare(strict_types=1);

namespace App\Command;

use App\Chat\SweepChatRelaysHandler;
use Symfony\Component\Console\Attribute\AsCommand;
use Symfony\Component\Console\Command\Command;
use Symfony\Component\Console\Style\SymfonyStyle;

/**
 * Runs the WhatsApp relay sweep once, as the `maintenance` worker does every minute: for a server whose worker was down,
 * or to see what it does.
 */
#[AsCommand(name: 'app:chat:sweep-relays', description: 'Mark silent WhatsApp relays offline and fail replies that could not be confirmed')]
final readonly class SweepChatRelaysCommand
{
    public function __construct(private SweepChatRelaysHandler $sweep)
    {
    }

    public function __invoke(SymfonyStyle $io): int
    {
        $result = $this->sweep->sweep();
        $io->success(\sprintf('%d relays went offline; %d replies could not be confirmed.', $result['offline'], $result['unconfirmed']));

        return Command::SUCCESS;
    }
}
