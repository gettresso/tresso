<?php

declare(strict_types=1);

namespace App\Activity;

use Doctrine\DBAL\Connection;
use Psr\Log\LoggerInterface;
use Symfony\Component\EventDispatcher\Attribute\AsEventListener;
use Symfony\Component\HttpKernel\KernelEvents;
use Symfony\Component\Uid\UuidV7;
use Symfony\Contracts\Service\ResetInterface;

/**
 * Keeps the entries of a request and writes them once the response was sent (`kernel.terminate`, after
 * `fastcgi_finish_request()`), straight through the connection, outside the entity manager. A failure to write is
 * logged and dropped: the log never fails or slows a request.
 */
final class ActivityLog implements ResetInterface
{
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
                $this->connection->insert('app_activity', [
                    'id' => UuidV7::generate($entry->occurredAt),
                    'owner_id' => $entry->owner->toRfc4122(),
                    'occurred_at' => $entry->occurredAt->format('Y-m-d H:i:s'),
                    'app_type' => $entry->app->type,
                    'app_id' => $entry->app->id,
                    'channel' => $entry->channel->value,
                    'method' => $entry->method,
                    'action' => $entry->action,
                    'kind' => $entry->kind->value,
                    'result' => $entry->result()->value,
                    'reason' => $entry->reason?->value,
                    'duration_ms' => max(0, $entry->durationMs),
                    'scopes' => json_encode($entry->scopes, \JSON_THROW_ON_ERROR),
                    'object_type' => $entry->objectType,
                    'object_list' => $entry->objectList ? 'true' : 'false',
                    'object_id' => $entry->objectId,
                ]);
            } catch (\Throwable $exception) {
                // The user's own row can be gone (deleted meanwhile): nothing to keep then either.
                $this->logger->warning('An entry of the app activity log was not written.', ['exception' => $exception]);
            }
        }
    }

    public function reset(): void
    {
        $this->pending = [];
    }
}
