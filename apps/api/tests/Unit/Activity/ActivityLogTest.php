<?php

declare(strict_types=1);

namespace App\Tests\Unit\Activity;

use App\Activity\ActivityApp;
use App\Activity\ActivityChannel;
use App\Activity\ActivityEntry;
use App\Activity\ActivityKind;
use App\Activity\ActivityLog;
use App\Activity\ActivityReason;
use Doctrine\DBAL\Connection;
use PHPUnit\Framework\TestCase;
use Psr\Log\AbstractLogger;
use Symfony\Component\Uid\Uuid;

/**
 * A log write that fails never reaches the request: it is dropped and reported as an error, with ids and codes only.
 */
final class ActivityLogTest extends TestCase
{
    public function testAFailedWriteIsAnErrorWithIdsAndCodesAndIsDropped(): void
    {
        $connection = $this->createStub(Connection::class);
        $connection->method('fetchOne')->willThrowException(new \RuntimeException('The database is gone, with anna@partner.example in it.'));
        $logger = new class extends AbstractLogger {
            /** @var list<array{mixed, string, array<mixed>}> */
            public array $records = [];

            public function log($level, \Stringable|string $message, array $context = []): void
            {
                $this->records[] = [$level, (string) $message, $context];
            }
        };
        $log = new ActivityLog($connection, $logger);
        $owner = Uuid::v7();
        $log->record(new ActivityEntry($owner, new \DateTimeImmutable(), ActivityApp::client('claude'), ActivityChannel::Api, 'GET', '/api/v1/chats/{id}', ActivityKind::Read, ActivityReason::NotFound, 3, ['chat:read']));

        $log->write();

        self::assertCount(1, $logger->records);
        [$level, $message, $context] = $logger->records[0];
        self::assertSame('error', $level);
        self::assertSame('An entry of the app activity log was not written.', $message);
        self::assertSame([
            'owner' => $owner->toRfc4122(),
            'app' => 'client:claude',
            'channel' => 'api',
            'action' => '/api/v1/chats/{id}',
            'result' => 'refused',
            'reason' => 'not_found',
            'error' => \RuntimeException::class,
        ], $context, 'No message text of the failure: it could hold anything.');

        $logger->records = [];
        $log->write();
        self::assertSame([], $logger->records, 'A dropped entry is not tried again.');
    }
}
