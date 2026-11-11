<?php

declare(strict_types=1);

namespace App\Tests\Unit\Security;

use PHPUnit\Framework\TestCase;
use Symfony\Component\HttpFoundation\Session\Storage\Handler\RedisSessionHandler;
use Symfony\Component\Yaml\Yaml;

/**
 * Where the sign-in session lives (config/packages/framework.yaml): in Redis in every environment that serves
 * browsers, so all API instances share it and a deploy keeps it, with its lifetime written down rather than left to
 * PHP's defaults. Only the tests keep it in memory.
 */
final class SignInSessionConfigTest extends TestCase
{
    public function testSessionsLiveInRedisWithAnExplicitLifetime(): void
    {
        $config = $this->config();
        $session = $this->path($config, 'framework', 'session');

        self::assertSame('app.session_handler', $session['handler_id'] ?? null);
        self::assertSame(0, $session['cookie_lifetime'] ?? null, 'The session cookie ends with the browser; remember-me is what lasts.');
        self::assertSame('auto', $session['cookie_secure'] ?? null);
        self::assertTrue($session['cookie_httponly'] ?? null);
        self::assertSame('lax', $session['cookie_samesite'] ?? null);

        $handler = $this->path($config, 'services', 'app.session_handler');
        self::assertSame(RedisSessionHandler::class, $handler['class'] ?? null);
        $arguments = $handler['arguments'] ?? null;
        self::assertIsArray($arguments);
        self::assertSame('@app.session_redis', $arguments[0] ?? null);
        $options = $arguments[1] ?? null;
        self::assertIsArray($options);
        self::assertSame($session['gc_maxlifetime'] ?? null, $options['ttl'] ?? null, 'Redis expires a session when PHP would.');

        $connection = $this->path($config, 'services', 'app.session_redis');
        self::assertSame(['%env(REDIS_URL)%', ['lazy' => true]], $connection['arguments'] ?? null);
    }

    public function testOnlyTheTestsChangeWhereSessionsAre(): void
    {
        $config = $this->config();

        self::assertSame([], array_values(array_diff(array_keys($config), ['framework', 'services', 'when@test'])), 'No environment but test overrides the session.');
        $test = $this->path($config, 'when@test', 'framework', 'session');
        self::assertSame(['storage_factory_id' => 'session.storage.factory.mock_file'], $test);
    }

    /**
     * @return array<mixed>
     */
    private function config(): array
    {
        $config = Yaml::parseFile(\dirname(__DIR__, 3).'/config/packages/framework.yaml');
        self::assertIsArray($config);

        return $config;
    }

    /**
     * @param array<mixed> $config
     *
     * @return array<mixed>
     */
    private function path(array $config, string ...$keys): array
    {
        $node = $config;
        foreach ($keys as $key) {
            self::assertIsArray($node);
            self::assertArrayHasKey($key, $node, implode('.', $keys));
            $node = $node[$key];
        }
        self::assertIsArray($node);

        return $node;
    }
}
