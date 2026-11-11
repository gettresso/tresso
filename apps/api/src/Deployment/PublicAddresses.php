<?php

declare(strict_types=1);

namespace App\Deployment;

use Symfony\Component\DependencyInjection\Attribute\Autowire;
use Symfony\Component\HttpFoundation\Request;

/**
 * The public addresses this server answers on, in one place:
 * - API_PUBLIC_URL: the API, the token endpoint, registration, the metadata and the issuer of every token;
 * - AUTH_PUBLIC_URL: where people sign in, sign out and allow apps (/login, /logout, /oauth/authorize). Tresso Cloud
 *   serves these pages on the web app's host through its proxy, so the sign-in cookie belongs to the app's address;
 * - MCP_PUBLIC_URL: the MCP endpoint on a host of its own. With MCP_ON_API_HOST (on by default) the endpoint keeps
 *   answering on the API host too, for clients that were set up with that address.
 * Left empty, AUTH_PUBLIC_URL and MCP_PUBLIC_URL are the API address, so a server with one API host works as before.
 * WEB_APP_URL, the web app, is here too, since the proxy may send the sign-in pages there.
 */
final readonly class PublicAddresses
{
    private string $api;
    private string $auth;
    private string $mcp;
    private string $web;

    public function __construct(
        #[Autowire(env: 'API_PUBLIC_URL')]
        string $api,
        #[Autowire(env: 'AUTH_PUBLIC_URL')]
        string $auth,
        #[Autowire(env: 'MCP_PUBLIC_URL')]
        string $mcp,
        #[Autowire(env: 'bool:MCP_ON_API_HOST')]
        private bool $mcpOnApiHost,
        #[Autowire(env: 'WEB_APP_URL')]
        string $web,
    ) {
        $this->api = self::address('API_PUBLIC_URL', $api);
        if ('' === $this->api) {
            throw new \InvalidArgumentException('API_PUBLIC_URL is empty.');
        }
        $this->auth = self::address('AUTH_PUBLIC_URL', $auth) ?: $this->api;
        $this->mcp = self::address('MCP_PUBLIC_URL', $mcp) ?: $this->api;
        $this->web = self::address('WEB_APP_URL', $web);
    }

    public function api(): string
    {
        return $this->api;
    }

    public function auth(): string
    {
        return $this->auth;
    }

    public function mcp(): string
    {
        return $this->mcp;
    }

    /** Whether the MCP endpoint has a host of its own. */
    public function mcpHasItsOwnHost(): bool
    {
        return self::hostOf($this->mcp) !== self::hostOf($this->api);
    }

    /** Whether /mcp answers on the API host: always when it has no host of its own, else while MCP_ON_API_HOST is on. */
    public function mcpOnApiHost(): bool
    {
        return !$this->mcpHasItsOwnHost() || $this->mcpOnApiHost;
    }

    public function isApiHost(Request $request): bool
    {
        return self::hostOf($this->api) === strtolower($request->getHttpHost());
    }

    public function isAuthHost(Request $request): bool
    {
        return self::hostOf($this->auth) === strtolower($request->getHttpHost());
    }

    public function isWebHost(Request $request): bool
    {
        return '' !== $this->web && self::hostOf($this->web) === strtolower($request->getHttpHost());
    }

    public function isMcpHost(Request $request): bool
    {
        return self::hostOf($this->mcp) === strtolower($request->getHttpHost());
    }

    /**
     * The host with its port, as a request's Host header carries it (`api.example.com`, `localhost:8080`); the port
     * only when it is not the scheme's default.
     */
    public static function hostOf(string $url): string
    {
        $host = strtolower((string) parse_url($url, \PHP_URL_HOST));
        $port = parse_url($url, \PHP_URL_PORT);
        $scheme = strtolower((string) parse_url($url, \PHP_URL_SCHEME));
        if (\is_int($port) && !('https' === $scheme && 443 === $port) && !('http' === $scheme && 80 === $port)) {
            $host .= ':'.$port;
        }

        return $host;
    }

    /** An address without a trailing slash; empty when not set. */
    private static function address(string $name, string $url): string
    {
        $url = rtrim(trim($url), '/');
        if ('' !== $url && ('' === (string) parse_url($url, \PHP_URL_SCHEME) || '' === (string) parse_url($url, \PHP_URL_HOST))) {
            throw new \InvalidArgumentException(\sprintf('%s must be an address with a scheme and a host, such as https://mail.example.com.', $name));
        }

        return $url;
    }
}
