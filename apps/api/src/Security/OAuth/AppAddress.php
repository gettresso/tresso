<?php

declare(strict_types=1);

namespace App\Security\OAuth;

/**
 * Where an app that is not ours lives, as people should see it: the host its redirect URI sends them to. That is the
 * one thing about such an app that is checked (the browser goes there with the code), unlike its name.
 */
final readonly class AppAddress
{
    private const array LOOPBACK_HOSTS = ['127.0.0.1', '[::1]', 'localhost'];

    private function __construct(
        /** The host (https), `localhost` (an app on this computer) or `scheme://host` (an app's own scheme). */
        public string $domain,
        /** Whether the app runs on the user's own computer, reached over http on a loopback address. */
        public bool $onThisComputer,
    ) {
    }

    public static function of(string $redirectUri): self
    {
        $parts = parse_url($redirectUri);
        $scheme = \is_array($parts) ? strtolower($parts['scheme'] ?? '') : '';
        $host = \is_array($parts) ? strtolower($parts['host'] ?? '') : '';

        if ('http' === $scheme && \in_array($host, self::LOOPBACK_HOSTS, true)) {
            return new self($host, true);
        }
        if ('https' === $scheme || 'http' === $scheme) {
            return new self($host, false);
        }

        return new self('' === $host ? $scheme.':' : $scheme.'://'.$host, true);
    }
}
