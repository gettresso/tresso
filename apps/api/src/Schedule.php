<?php

declare(strict_types=1);

namespace App;

use App\Billing\ReconcileSubscriptions;
use App\Bulk\SweepBulkActions;
use App\Chat\SweepChatMedia;
use App\Chat\SweepChatRelays;
use App\Scan\SweepPendingScans;
use App\Security\OAuth\PurgeExpiredOAuthTokens;
use App\Security\OAuth\PurgeUnusedRegisteredClients;
use App\Security\PersonalAccessToken\PurgeOldPersonalAccessTokens;
use App\Storage\SweepReencryption;
use App\Sync\Calendar\SweepMeetingRequests;
use App\Sync\Ingest\SweepOrphanedMessages;
use Symfony\Component\Scheduler\Attribute\AsSchedule;
use Symfony\Component\Scheduler\RecurringMessage;
use Symfony\Component\Scheduler\Schedule as SymfonySchedule;
use Symfony\Component\Scheduler\ScheduleProviderInterface;
use Symfony\Contracts\Cache\CacheInterface;

/**
 * Recurring work, sent to the `scheduler_default` transport. The `maintenance` worker consumes it alone, so a long
 * sweep never holds up outgoing mail on `async`.
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
            ->add(RecurringMessage::every('5 minutes', new SweepOrphanedMessages()))
            ->add(RecurringMessage::every('5 minutes', new SweepBulkActions()))
            ->add(RecurringMessage::every('1 minute', new SweepChatRelays()))
            ->add(RecurringMessage::every('1 minute', new SweepMeetingRequests()))
            ->add(RecurringMessage::every('10 minutes', new SweepChatMedia()))
            ->add(RecurringMessage::every('1 hour', new SweepReencryption()))
            ->add(RecurringMessage::cron('17 3 * * *', new ReconcileSubscriptions()))
            ->add(RecurringMessage::cron('41 3 * * *', new PurgeOldPersonalAccessTokens()))
            ->add(RecurringMessage::cron('47 3 * * *', new PurgeUnusedRegisteredClients()))
            ->add(RecurringMessage::cron('53 3 * * *', new PurgeExpiredOAuthTokens()));
    }
}
