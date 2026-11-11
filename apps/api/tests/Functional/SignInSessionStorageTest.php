<?php

declare(strict_types=1);

namespace App\Tests\Functional;

use Symfony\Bundle\FrameworkBundle\Test\KernelTestCase;
use Symfony\Component\HttpFoundation\Session\Storage\Handler\RedisSessionHandler;

/**
 * The sign-in session's handler against the real Redis: what one API instance wrote, a freshly started one reads, so
 * a deploy or a second instance keeps the sign-in; and Redis ends it after the two idle hours. The tests' own
 * sessions use the mock storage, so this drives the configured handler directly.
 */
final class SignInSessionStorageTest extends KernelTestCase
{
    public function testASessionOutlivesTheInstanceThatWroteIt(): void
    {
        $id = bin2hex(random_bytes(16));

        $writer = $this->handler();
        self::assertTrue($writer->open('', 'PHPSESSID'));
        self::assertTrue($writer->write($id, 'signed-in-as|kim'));
        $writer->close();
        self::ensureKernelShutdown();

        $reader = $this->handler();
        self::assertTrue($reader->open('', 'PHPSESSID'));
        self::assertSame('signed-in-as|kim', $reader->read($id), 'Another kernel, another connection, the same session.');

        $redis = static::getContainer()->get('app.session_redis');
        self::assertInstanceOf(\Redis::class, $redis);
        $ttl = $redis->ttl('session:'.$id);
        self::assertIsInt($ttl);
        self::assertGreaterThan(7000, $ttl);
        self::assertLessThanOrEqual(7200, $ttl);

        self::assertTrue($reader->destroy($id));
        $reader->close();
    }

    private function handler(): RedisSessionHandler
    {
        self::bootKernel();
        $handler = static::getContainer()->get('app.session_handler');
        self::assertInstanceOf(RedisSessionHandler::class, $handler);

        return $handler;
    }
}
