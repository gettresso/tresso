<?php

declare(strict_types=1);

namespace App\Tests\Unit\Deployment;

use PHPUnit\Framework\Attributes\DataProvider;
use PHPUnit\Framework\TestCase;
use Symfony\Component\Finder\Finder;
use Symfony\Component\Scheduler\Attribute\AsSchedule;
use Symfony\Component\Yaml\Yaml;

/**
 * The workers in both compose files: every Messenger transport and every schedule has exactly one consumer, and the
 * sweeps and purges of the default schedule never share a worker with outgoing mail.
 */
final class WorkerConsumersTest extends TestCase
{
    /**
     * @return iterable<string, array{string}>
     */
    public static function composeFiles(): iterable
    {
        yield 'compose.prod.yaml' => ['compose.prod.yaml'];
        yield 'compose.yaml' => ['compose.yaml'];
    }

    #[DataProvider('composeFiles')]
    public function testEveryTransportAndScheduleHasExactlyOneConsumer(string $file): void
    {
        $consumers = [];
        foreach (self::consumedTransports($file) as $service => $transports) {
            foreach ($transports as $transport) {
                $consumers[$transport][] = $service;
            }
        }

        foreach (self::expectedTransports() as $transport) {
            self::assertCount(1, $consumers[$transport] ?? [], \sprintf('%s: `%s` is consumed by exactly one worker.', $file, $transport));
        }
        self::assertSame([], array_values(array_diff(array_keys($consumers), self::expectedTransports())), $file.': no worker consumes a transport that does not exist.');
    }

    #[DataProvider('composeFiles')]
    public function testTheDefaultScheduleHasAWorkerOfItsOwn(string $file): void
    {
        $workers = self::consumedTransports($file);
        $maintenance = array_keys(array_filter($workers, static fn (array $transports): bool => \in_array('scheduler_default', $transports, true)));

        self::assertSame(['maintenance'], $maintenance);
        self::assertSame(['scheduler_default'], $workers['maintenance'], 'A sweep with much to delete never holds up a queued send on `async`.');
    }

    /**
     * Per service of the compose file, the transports its `messenger:consume` command names.
     *
     * @return array<string, list<string>>
     */
    private static function consumedTransports(string $file): array
    {
        $compose = Yaml::parseFile(\dirname(__DIR__, 5).'/'.$file);
        self::assertIsArray($compose);
        $services = $compose['services'] ?? null;
        self::assertIsArray($services);

        $workers = [];
        foreach ($services as $name => $service) {
            $command = \is_array($service) ? ($service['command'] ?? null) : null;
            if (!\is_array($command) || !\in_array('messenger:consume', $command, true)) {
                continue;
            }
            $arguments = \array_slice($command, (int) array_search('messenger:consume', $command, true) + 1);
            $workers[(string) $name] = array_values(array_filter(
                array_map(static fn (mixed $argument): string => \is_string($argument) ? $argument : '', $arguments),
                static fn (string $argument): bool => '' !== $argument && !str_starts_with($argument, '-'),
            ));
        }

        return $workers;
    }

    /**
     * The transports of messenger.yaml that a worker consumes (all but the failure transport and `sync`), and one
     * `scheduler_<name>` per schedule.
     *
     * @return list<string>
     */
    private static function expectedTransports(): array
    {
        $config = Yaml::parseFile(\dirname(__DIR__, 3).'/config/packages/messenger.yaml');
        self::assertIsArray($config);
        $framework = $config['framework'] ?? null;
        self::assertIsArray($framework);
        $messenger = $framework['messenger'] ?? null;
        self::assertIsArray($messenger);
        $transports = $messenger['transports'] ?? null;
        self::assertIsArray($transports);

        $expected = array_values(array_diff(array_map(strval(...), array_keys($transports)), ['failed', 'sync']));

        $files = new Finder()->files()->in(\dirname(__DIR__, 3).'/src')->name('*.php')->contains('#[AsSchedule');
        foreach ($files as $file) {
            $class = 'App\\'.str_replace(['/', '.php'], ['\\', ''], $file->getRelativePathname());
            if (!class_exists($class)) {
                continue;
            }
            foreach (new \ReflectionClass($class)->getAttributes(AsSchedule::class) as $attribute) {
                $expected[] = 'scheduler_'.$attribute->newInstance()->name;
            }
        }
        sort($expected);

        return $expected;
    }
}
