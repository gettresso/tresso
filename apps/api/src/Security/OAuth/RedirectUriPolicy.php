<?php

declare(strict_types=1);

namespace App\Security\OAuth;

/**
 * Which redirect URIs an app that registers itself may use (RFC 8252 7 and the OAuth 2.0 Security BCP, RFC 9700):
 *
 * - `https://` on a host written in plain ASCII letters, digits, hyphens and dots (internationalized names only as
 *   punycode, `xn--...`), so the consent screen shows exactly where the user is sent;
 * - `http://` only on this computer (127.0.0.1, [::1] or localhost), on any port;
 * - an app's own scheme only in reverse-domain form, such as `com.example.app:/callback`.
 *
 * Never a fragment, a wildcard, credentials, a backslash or a percent sign in the host, a scheme a browser or the
 * operating system handles itself (`com.apple.*`, `x-apple.*`, `com.microsoft.*`, `microsoft.*`, `ms-*`,
 * `com.google.*`, `android*`, `windows*`), and nothing that looks like Tresso: no Tresso host, and no host or scheme
 * with a label that has "tresso" in it.
 */
final readonly class RedirectUriPolicy
{
    public const int MAX_LENGTH = 2000;

    private const array LOOPBACK_HOSTS = ['127.0.0.1', '[::1]', 'localhost'];

    /** ASCII host names: labels of letters, digits and inner hyphens, separated by dots. */
    private const string HOST_NAME = '/^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?(?:\.[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?)*$/i';

    /** A reverse-domain scheme: at least two such labels, the first starting with a letter (RFC 3986 3.1). */
    private const string REVERSE_DOMAIN_SCHEME = '/^[a-z][a-z0-9-]*(?:\.[a-z0-9](?:[a-z0-9-]*[a-z0-9])?)+$/';

    public function __construct(private TressoLookalikes $tresso)
    {
    }

    /**
     * @throws ClientRegistrationRefused when the URI is not allowed
     */
    public function check(string $uri): void
    {
        if ('' === $uri || \strlen($uri) > self::MAX_LENGTH) {
            throw ClientRegistrationRefused::redirectUri(\sprintf('A redirect URI must be 1 to %d characters long.', self::MAX_LENGTH));
        }
        if (1 === preg_match('/[^\x21-\x7e]/', $uri)) {
            throw ClientRegistrationRefused::redirectUri('A redirect URI must be plain ASCII without spaces; write an internationalized host name as punycode (xn--...).');
        }
        if (str_contains($uri, '#')) {
            throw ClientRegistrationRefused::redirectUri('A redirect URI cannot have a fragment.');
        }
        if (str_contains($uri, '*')) {
            throw ClientRegistrationRefused::redirectUri('A redirect URI cannot contain a wildcard.');
        }
        if (str_contains($uri, '\\')) {
            throw ClientRegistrationRefused::redirectUri('A redirect URI cannot contain a backslash.');
        }

        $parts = parse_url($uri);
        $scheme = \is_array($parts) ? strtolower($parts['scheme'] ?? '') : '';
        if ('' === $scheme || isset($parts['user']) || isset($parts['pass'])) {
            throw ClientRegistrationRefused::redirectUri(\sprintf('"%s" is not an absolute URI without credentials.', $uri));
        }
        $host = $parts['host'] ?? '';

        if ('https' === $scheme) {
            $this->checkWebHost($host);

            return;
        }
        if ('http' === $scheme) {
            if (!\in_array(strtolower($host), self::LOOPBACK_HOSTS, true)) {
                throw ClientRegistrationRefused::redirectUri('An http redirect URI is only allowed on this computer (127.0.0.1, [::1] or localhost); use https elsewhere.');
            }

            return;
        }

        $this->checkAppScheme($scheme);
    }

    private function checkWebHost(string $host): void
    {
        if ('' === $host || 1 !== preg_match(self::HOST_NAME, $host)) {
            throw ClientRegistrationRefused::redirectUri('An https redirect URI needs a host in ASCII letters, digits, hyphens and dots (punycode for internationalized names).');
        }
        if ($this->tresso->isTressoHost($host)) {
            throw ClientRegistrationRefused::redirectUri('An app that is not Tresso cannot send people to a Tresso address.');
        }
    }

    /**
     * Schemes the operating system handles itself (settings panes, store links, system tools): opening one runs
     * something of the system rather than the app that registered.
     */
    private static function belongsToTheSystem(string $scheme): bool
    {
        $labels = explode('.', $scheme);
        $first = $labels[0];
        $vendor = $first.'.'.($labels[1] ?? '');
        if (\in_array($vendor, ['com.apple', 'com.microsoft', 'com.google'], true)) {
            return true;
        }
        foreach (['x-apple', 'microsoft', 'ms-', 'android', 'windows'] as $prefix) {
            if (str_starts_with($first, $prefix)) {
                return true;
            }
        }

        return false;
    }

    private function checkAppScheme(string $scheme): void
    {
        if (1 !== preg_match(self::REVERSE_DOMAIN_SCHEME, $scheme)) {
            throw ClientRegistrationRefused::redirectUri(\sprintf('The scheme "%s" is not allowed: an app\'s own scheme must be a domain it owns, reversed, such as com.example.app:/callback.', $scheme));
        }
        if (self::belongsToTheSystem($scheme)) {
            throw ClientRegistrationRefused::redirectUri(\sprintf('The scheme "%s" belongs to the operating system, not to an app.', $scheme));
        }
        if ($this->tresso->isTressoScheme($scheme)) {
            throw ClientRegistrationRefused::redirectUri(\sprintf('The scheme "%s" names Tresso and is reserved for Tresso\'s own apps.', $scheme));
        }
    }
}
