<?php

declare(strict_types=1);

namespace App\Tests\Unit\Mcp;

use App\Deployment\McpHosts;
use PHPUnit\Framework\TestCase;
use Symfony\Component\Yaml\Yaml;

/**
 * Which hosts /mcp answers in each environment (config/packages/mcp.yaml): production only the public hosts of the MCP
 * endpoint ({@see McpHosts}), so a page that rebinds a name to a loopback address cannot reach it; loopback only in
 * dev and test.
 */
final class McpConfigTest extends TestCase
{
    private const string PUBLIC_HOSTS = '%env(mcp_hosts:MCP_PUBLIC_URL)%';
    private const string WITH_LOOPBACK = '%env(mcp_hosts_and_loopback:MCP_PUBLIC_URL)%';

    public function testProductionOnlyAcceptsThePublicHosts(): void
    {
        $config = $this->config();

        self::assertSame(self::PUBLIC_HOSTS, $this->allowedHosts($config['mcp'] ?? null), 'The configuration every environment starts from.');
        self::assertArrayNotHasKey('when@prod', $config, 'Production adds nothing to it.');
    }

    public function testLoopbackIsOnlyForDevelopmentAndTests(): void
    {
        $config = $this->config();

        foreach (['when@dev', 'when@test'] as $environment) {
            $block = $config[$environment] ?? null;
            self::assertIsArray($block, $environment);
            self::assertSame(self::WITH_LOOPBACK, $this->allowedHosts($block['mcp'] ?? null), $environment);
        }
        self::assertSame([], array_values(array_diff(array_keys($config), ['mcp', 'when@dev', 'when@test'])), 'No other environment changes the hosts.');
    }

    public function testThePublicHostsFollowTheAddresses(): void
    {
        self::assertSame(['api.example.com'], McpHosts::hosts('https://api.example.com', '', true, false), 'No host of its own: the API host.');
        self::assertSame(['mcp.example.com', 'api.example.com'], McpHosts::hosts('https://api.example.com', 'https://mcp.example.com', true, false), 'Its own host, and the API host while /mcp still answers there.');
        self::assertSame(['mcp.example.com'], McpHosts::hosts('https://api.example.com', 'https://mcp.example.com', false, false));
        self::assertSame(['mcp.example.com', 'localhost', '127.0.0.1', '[::1]'], McpHosts::hosts('https://api.example.com', 'https://mcp.example.com:8443', false, true), 'Without a port; loopback only when asked.');
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

    private function allowedHosts(mixed $mcp): mixed
    {
        self::assertIsArray($mcp);
        $servers = $mcp['servers'] ?? null;
        self::assertIsArray($servers);
        $default = $servers['default'] ?? null;
        self::assertIsArray($default);
        $http = $default['http'] ?? null;
        self::assertIsArray($http);

        return $http['allowed_hosts'] ?? null;
    }
}
