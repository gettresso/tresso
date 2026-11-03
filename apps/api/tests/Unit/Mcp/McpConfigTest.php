<?php

declare(strict_types=1);

namespace App\Tests\Unit\Mcp;

use PHPUnit\Framework\TestCase;
use Symfony\Component\Yaml\Yaml;

/**
 * Which hosts /mcp answers in each environment (config/packages/mcp.yaml): production only the public host of the
 * API, so a page that rebinds a name to a loopback address cannot reach it; loopback only in dev and test.
 */
final class McpConfigTest extends TestCase
{
    private const array LOOPBACK = ['localhost', '127.0.0.1', '[::1]'];
    private const string PUBLIC_HOST = '%env(key:host:url:API_PUBLIC_URL)%';

    public function testProductionOnlyAcceptsThePublicHost(): void
    {
        $config = $this->config();

        self::assertSame([self::PUBLIC_HOST], $this->allowedHosts($config['mcp'] ?? null), 'The configuration every environment starts from.');
        self::assertArrayNotHasKey('when@prod', $config, 'Production adds nothing to it.');
    }

    public function testLoopbackIsOnlyForDevelopmentAndTests(): void
    {
        $config = $this->config();

        foreach (['when@dev', 'when@test'] as $environment) {
            $block = $config[$environment] ?? null;
            self::assertIsArray($block, $environment);
            self::assertSame([self::PUBLIC_HOST, ...self::LOOPBACK], $this->allowedHosts($block['mcp'] ?? null), $environment);
        }
        self::assertSame([], array_values(array_diff(array_keys($config), ['mcp', 'when@dev', 'when@test'])), 'No other environment changes the hosts.');
    }

    /**
     * @return array<mixed>
     */
    private function config(): array
    {
        $config = Yaml::parseFile(\dirname(__DIR__, 3).'/config/packages/mcp.yaml');
        self::assertIsArray($config);

        return $config;
    }

    /**
     * @return array<mixed>
     */
    private function allowedHosts(mixed $mcp): array
    {
        self::assertIsArray($mcp);
        $servers = $mcp['servers'] ?? null;
        self::assertIsArray($servers);
        $default = $servers['default'] ?? null;
        self::assertIsArray($default);
        $http = $default['http'] ?? null;
        self::assertIsArray($http);
        $hosts = $http['allowed_hosts'] ?? null;
        self::assertIsArray($hosts);

        return $hosts;
    }
}
