<?php

declare(strict_types=1);

namespace App;

use App\Billing\ReconcileSubscriptions;
use App\Scan\SweepPendingScans;
use App\Storage\SweepReencryption;
use Symfony\Component\Scheduler\Attribute\AsSchedule;
use Symfony\Component\Scheduler\RecurringMessage;
use Symfony\Component\Scheduler\Schedule as SymfonySchedule;
use Symfony\Component\Scheduler\ScheduleProviderInterface;
use Symfony\Contracts\Cache\CacheInterface;

/**
 * Recurring work, sent to the `scheduler_default` transport that a messenger worker consumes.
 */
#[AsSchedule]
final readonly class Schedule implements ScheduleProviderInterface
{
    public function __construct(private CacheInterface $cache)
    {
    }

    public function getSchedule(): SymfonySchedule
    {
        return new SymfonySchedule()
            ->stateful($this->cache)
            ->processOnlyLastMissedRun(true)
            ->add(RecurringMessage::every('5 minutes', new SweepPendingScans()))
            ->add(RecurringMessage::every('1 hour', new SweepReencryption()))
            ->add(RecurringMessage::cron('17 3 * * *', new ReconcileSubscriptions()));
    }
}
