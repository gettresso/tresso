<?php

declare(strict_types=1);

namespace App\Tests\Unit;

use PHPUnit\Framework\Attributes\DataProvider;
use PHPUnit\Framework\TestCase;
use Symfony\Component\Cache\Adapter\ArrayAdapter;
use Symfony\Component\Finder\Finder;
use Symfony\Component\Scheduler\Attribute\AsSchedule;
use Symfony\Component\Scheduler\ScheduleProviderInterface;
use Symfony\Contracts\Cache\CacheInterface;

/**
 * Every schedule builds and every recurring message has a next run. A trigger whose package is missing from the
 * production install (RecurringMessage::cron needs dragonmantank/cron-expression) throws while the schedule is built,
 * which crash-loops the messenger worker that consumes all schedules.
 */
final class ScheduleTest extends TestCase
{
    /**
     * @return iterable<string, array{class-string<ScheduleProviderInterface>}>
     */
    public static function schedules(): iterable
    {
        $files = new Finder()->files()->in(\dirname(__DIR__, 2).'/src')->name('*.php')->contains('#[AsSchedule');
        foreach ($files as $file) {
            $class = 'App\\'.str_replace(['/', '.php'], ['\\', ''], $file->getRelativePathname());
            if (!is_a($class, ScheduleProviderInterface::class, true)) {
                continue;
            }
            if ([] === new \ReflectionClass($class)->getAttributes(AsSchedule::class)) {
                continue;
            }

            yield $class => [$class];
        }
    }

    public function testEveryScheduleIsFound(): void
    {
        self::assertGreaterThanOrEqual(4, iterator_count(self::schedules()));
    }

    /**
     * @param class-string<ScheduleProviderInterface> $class
     */
    #[DataProvider('schedules')]
    public function testTheScheduleBuildsAndEveryMessageRunsAgain(string $class): void
    {
        $schedule = $this->provider($class)->getSchedule();

        $messages = $schedule->getRecurringMessages();
        self::assertNotEmpty($messages);
        $now = new \DateTimeImmutable('2026-07-01T12:00:00Z');
        foreach ($messages as $message) {
            $next = $message->getTrigger()->getNextRunDate($now);
            self::assertNotNull($next, \sprintf('%s in %s never runs.', $message->getTrigger(), $class));
            self::assertGreaterThan($now, $next);
        }
    }

    /**
     * @param class-string<ScheduleProviderInterface> $class
     */
    private function provider(string $class): ScheduleProviderInterface
    {
        $arguments = [];
        foreach (new \ReflectionClass($class)->getConstructor()?->getParameters() ?? [] as $parameter) {
            $type = $parameter->getType();
            if (!$type instanceof \ReflectionNamedType || CacheInterface::class !== $type->getName()) {
                self::fail(\sprintf('%s needs a %s; give the test one.', $class, (string) $type));
            }
            $arguments[] = new ArrayAdapter();
        }

        return new $class(...$arguments);
    }
}
