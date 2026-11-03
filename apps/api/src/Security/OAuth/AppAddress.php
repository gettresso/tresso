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
        /** The host (https), the loopback host (an app on this computer) or the app's own reverse-domain scheme. */
        public string $domain,
        /** Whether the app runs on the user's own device: over http on a loopback address, or with its own scheme. */
        public bool $onThisComputer,
    ) {
    }

    /**
     * The registration only lets through ASCII hosts and reverse-domain schemes ({@see RedirectUriPolicy}); they are
     * shown in lower case, without a trailing dot.
     */
    public static function of(string $redirectUri): self
    {
        $parts = parse_url($redirectUri);
        $scheme = \is_array($parts) ? strtolower($parts['scheme'] ?? '') : '';
        $host = \is_array($parts) ? rtrim(strtolower($parts['host'] ?? ''), '.') : '';

        if ('http' === $scheme && \in_array($host, self::LOOPBACK_HOSTS, true)) {
            return new self($host, true);
        }
        if ('https' === $scheme || 'http' === $scheme) {
            return new self($host, false);
        }

        return new self($scheme, true);
    }

    /**
     * The different places a client sends people back to, in the order it registered them.
     *
     * @param iterable<\Stringable|string> $redirectUris
     *
     * @return list<string>
     */
    public static function domainsOf(iterable $redirectUris): array
    {
        $domains = [];
        foreach ($redirectUris as $uri) {
            $domains[] = self::of((string) $uri)->domain;
        }

        return array_values(array_unique($domains));
    }
}
