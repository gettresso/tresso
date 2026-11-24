<?php

declare(strict_types=1);

namespace App\Activity;

use App\Entity\AppActivity;
use Doctrine\DBAL\Connection;
use Psr\Log\LoggerInterface;
use Symfony\Component\EventDispatcher\Attribute\AsEventListener;
use Symfony\Component\HttpKernel\KernelEvents;
use Symfony\Component\Uid\UuidV7;
use Symfony\Contracts\Service\ResetInterface;

/**
 * Keeps the entries of a request and writes them once the response was sent (`kernel.terminate`, after
 * `fastcgi_finish_request()`), straight through the connection, outside the entity manager. A failure to write is
 * logged as an error (with ids, the action and codes only) and dropped: the log never fails or slows a request.
 *
 * What one app can write is bounded:
 * - Repeats are one entry with a count, the time of the first and of the last: the same owner, app, way in, action,
 *   result and reason within a minute (an hour for a refused token), and for a send or a change the same object
 *   ({@see ActivityEntry::repeatKey()}). Reads of different objects fold into one entry that keeps no id and says it
 *   covers several.
 * - At most {@see DAILY_CAP} entries per owner and app per day ({@see AppActivityDay}). Past it, reads that went
 *   through fold into one entry "More activity was not recorded", whose count says how many; sends, changes, refusals
 *   and failures are still written, with an hourly repeat bucket, so nothing that matters can hide behind a flood.
 *   Two requests at the same moment may each write one entry past the cap; the cap is a bound, not an exact number.
 */
final class ActivityLog implements ResetInterface
{
    public const int DAILY_CAP = 2000;

    /** @var list<ActivityEntry> */
    private array $pending = [];

    public function __construct(
        private readonly Connection $connection,
        private readonly LoggerInterface $logger,
    ) {
    }

    public function record(ActivityEntry $entry): void
    {
        $this->pending[] = $entry;
    }

    #[AsEventListener(event: KernelEvents::TERMINATE)]
    public function write(): void
    {
        $entries = $this->pending;
        $this->pending = [];

        foreach ($entries as $entry) {
            try {
                $this->writeOne($entry);
            } catch (\Throwable $exception) {
                $this->logger->error('An entry of the app activity log was not written.', [
                    'owner' => $entry->owner->toRfc4122(),
                    'app' => $entry->app->key(),
                    'channel' => $entry->channel->value,
                    'action' => $entry->action,
                    'result' => $entry->result()->value,
                    'reason' => $entry->reason?->value,
                    'error' => $exception::class,
                ]);
            }
        }
    }

    private function writeOne(ActivityEntry $entry): void
    {
        $day = $entry->occurredAt->format('Y-m-d');
        $written = $this->connection->fetchOne(
            'SELECT entries FROM app_activity_day WHERE owner_id = :owner AND app_type = :type AND app_id = :app AND day = :day',
            ['owner' => $entry->owner->toRfc4122(), 'type' => $entry->app->type, 'app' => $entry->app->id, 'day' => $day],
        );
        $pastCap = \is_int($written) && $written >= self::DAILY_CAP;
        if ($pastCap && $entry->foldsPastCap()) {
            $this->upsert($entry, AppActivity::NOT_RECORDED, null, ActivityKind::Read, null, [], null, false, null, [], hash('sha256', implode('|', [$entry->owner->toRfc4122(), $entry->app->key(), $day, AppActivity::NOT_RECORDED])));

            return;
        }

        $inserted = $this->upsert(
            $entry,
            $entry->action,
            $entry->method,
            $entry->kind,
            $entry->reason,
            $entry->scopes,
            $entry->objectType,
            $entry->objectList,
            $entry->objectId,
            $entry->missingScopes,
            $entry->repeatKey($pastCap),
        );
        if ($inserted) {
            $this->connection->executeStatement(
                'INSERT INTO app_activity_day (owner_id, app_type, app_id, day, entries) VALUES (:owner, :type, :app, :day, 1)
                 ON CONFLICT (owner_id, app_type, app_id, day) DO UPDATE SET entries = app_activity_day.entries + 1',
                ['owner' => $entry->owner->toRfc4122(), 'type' => $entry->app->type, 'app' => $entry->app->id, 'day' => $day],
            );
        }
    }

    /**
     * Writes the entry, or counts one more of it when its repeat key is there already.
     *
     * @param list<string> $scopes
     * @param list<string> $missingScopes
     *
     * @return bool whether a new row was written
     */
    private function upsert(ActivityEntry $entry, string $action, ?string $method, ActivityKind $kind, ?ActivityReason $reason, array $scopes, ?string $objectType, bool $objectList, ?string $objectId, array $missingScopes, string $repeatKey): bool
    {
        $result = $reason?->result() ?? ActivityResult::Done;

        return true === $this->connection->fetchOne(
            'INSERT INTO app_activity (id, owner_id, occurred_at, last_occurred_at, app_type, app_id, channel, method, action, kind, result, reason, duration_ms, scopes, object_type, object_list, object_id, several_objects, missing_scopes, count, repeat_key)
             VALUES (:id, :owner, :at, :at, :type, :app, :channel, :method, :action, :kind, :result, :reason, :duration, :scopes, :objectType, :objectList, :objectId, false, :missing, 1, :repeat)
             ON CONFLICT (repeat_key) DO UPDATE SET
                 count = app_activity.count + 1,
                 last_occurred_at = GREATEST(app_activity.last_occurred_at, EXCLUDED.occurred_at),
                 several_objects = app_activity.several_objects OR app_activity.object_id IS DISTINCT FROM EXCLUDED.object_id,
                 object_id = CASE WHEN app_activity.object_id IS DISTINCT FROM EXCLUDED.object_id THEN NULL ELSE app_activity.object_id END
             RETURNING (xmax = 0)',
            [
                'id' => UuidV7::generate($entry->occurredAt),
                'owner' => $entry->owner->toRfc4122(),
                'at' => $entry->occurredAt->format('Y-m-d H:i:s'),
                'type' => $entry->app->type,
                'app' => $entry->app->id,
                'channel' => $entry->channel->value,
                'method' => AppActivity::NOT_RECORDED === $action ? null : $method,
                'action' => $action,
                'kind' => $kind->value,
                'result' => $result->value,
                'reason' => $reason?->value,
                'duration' => AppActivity::NOT_RECORDED === $action ? 0 : max(0, $entry->durationMs),
                'scopes' => json_encode($scopes, \JSON_THROW_ON_ERROR),
                'objectType' => $objectType,
                'objectList' => $objectList ? 'true' : 'false',
                'objectId' => $objectId,
                'missing' => json_encode($missingScopes, \JSON_THROW_ON_ERROR),
                'repeat' => $repeatKey,
            ],
        );
    }

    public function reset(): void
    {
        $this->pending = [];
    }
}
