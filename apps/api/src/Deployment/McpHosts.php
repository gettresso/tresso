<?php

declare(strict_types=1);

namespace App\Deployment;

use Symfony\Component\DependencyInjection\EnvVarProcessorInterface;

/**
 * The host names the MCP endpoint's DNS rebinding protection accepts (`allowed_hosts` in config/packages/mcp.yaml),
 * from MCP_PUBLIC_URL, API_PUBLIC_URL and MCP_ON_API_HOST as {@see PublicAddresses} reads them: the MCP host, and the
 * API host while /mcp still answers there. `%env(mcp_hosts:MCP_PUBLIC_URL)%` gives those, and
 * `%env(mcp_hosts_and_loopback:MCP_PUBLIC_URL)%` adds the loopback names local clients use in development and tests.
 * Host names without a port, as the protection compares them.
 */
final class McpHosts implements EnvVarProcessorInterface
{
    public const array LOOPBACK = ['localhost', '127.0.0.1', '[::1]'];

    /** @return list<string> */
    public function getEnv(string $prefix, string $name, \Closure $getEnv): array
    {
        $api = self::string($getEnv('API_PUBLIC_URL'));
        $mcp = self::string($getEnv($name));
        $onApiHost = filter_var(self::string($getEnv('MCP_ON_API_HOST')), \FILTER_VALIDATE_BOOL);

        return self::hosts($api, $mcp, $onApiHost, 'mcp_hosts_and_loopback' === $prefix);
    }

    /** @return list<string> */
    public static function hosts(string $api, string $mcp, bool $onApiHost, bool $loopback): array
    {
        $apiHost = strtolower((string) parse_url($api, \PHP_URL_HOST));
        $mcpHost = '' === trim($mcp) ? $apiHost : strtolower((string) parse_url($mcp, \PHP_URL_HOST));
        $hosts = [$mcpHost];
        if ($onApiHost || $mcpHost === $apiHost) {
            $hosts[] = $apiHost;
        }
        if ($loopback) {
            $hosts = [...$hosts, ...self::LOOPBACK];
        }

        return array_values(array_unique(array_filter($hosts, static fn (string $host): bool => '' !== $host)));
    }

    public static function getProvidedTypes(): array
    {
        return ['mcp_hosts' => 'array', 'mcp_hosts_and_loopback' => 'array'];
    }

    private static function string(mixed $value): string
    {
        return \is_string($value) ? $value : '';
    }
}
