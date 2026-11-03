<?php

declare(strict_types=1);

namespace App\Security\OAuth;

use Symfony\Component\DependencyInjection\Attribute\Autowire;

/**
 * Which redirect URIs an app that registers itself may use (RFC 8252 7 and the OAuth 2.0 Security BCP):
 *
 * - `https://` on any host;
 * - `http://` only on this computer (127.0.0.1, [::1] or localhost), on any port;
 * - an app's own scheme, when it names the app the way platforms do: the scheme itself in reverse-domain form
 *   (`com.example.app:/callback`), or a one-word scheme followed by a dotted host (`cursor://anysphere.cursor-mcp/...`).
 *   Never a scheme a browser runs or opens itself, and never the scheme of our own apps.
 *
 * Never a fragment or a wildcard.
 */
final readonly class RedirectUriPolicy
{
    public const int MAX_LENGTH = 2000;

    private const array LOOPBACK_HOSTS = ['127.0.0.1', '[::1]', 'localhost'];

    /** Schemes that a browser or operating system handles itself rather than handing to the app that registered. */
    private const array FORBIDDEN_SCHEMES = [
        'http', 'https', 'javascript', 'data', 'file', 'blob', 'filesystem', 'about', 'vbscript', 'ftp', 'ws', 'wss',
        'mailto', 'tel', 'sms', 'intent', 'chrome', 'chrome-extension', 'moz-extension', 'view-source',
    ];

    private string $ownScheme;

    public function __construct(
        #[Autowire(env: 'NATIVE_REDIRECT_URI')]
        string $nativeRedirectUri,
    ) {
        $this->ownScheme = strtolower((string) parse_url($nativeRedirectUri, \PHP_URL_SCHEME));
    }

    /**
     * @throws ClientRegistrationRefused when the URI is not allowed
     */
    public function check(string $uri): void
    {
        if ('' === $uri || \strlen($uri) > self::MAX_LENGTH) {
            throw ClientRegistrationRefused::redirectUri(\sprintf('A redirect URI must be 1 to %d characters long.', self::MAX_LENGTH));
        }
        if (1 === preg_match('/[\s\x00-\x1f\x7f]/', $uri)) {
            throw ClientRegistrationRefused::redirectUri('A redirect URI cannot contain spaces or control characters.');
        }
        if (str_contains($uri, '#')) {
            throw ClientRegistrationRefused::redirectUri('A redirect URI cannot have a fragment.');
        }
        if (str_contains($uri, '*')) {
            throw ClientRegistrationRefused::redirectUri('A redirect URI cannot contain a wildcard.');
        }

        $parts = parse_url($uri);
        $scheme = \is_array($parts) ? strtolower($parts['scheme'] ?? '') : '';
        if ('' === $scheme || isset($parts['user']) || isset($parts['pass'])) {
            throw ClientRegistrationRefused::redirectUri(\sprintf('"%s" is not an absolute URI without credentials.', $uri));
        }
        $host = strtolower($parts['host'] ?? '');

        if ('https' === $scheme) {
            if ('' === $host) {
                throw ClientRegistrationRefused::redirectUri('An https redirect URI needs a host.');
            }

            return;
        }
        if ('http' === $scheme) {
            if (!\in_array($host, self::LOOPBACK_HOSTS, true)) {
                throw ClientRegistrationRefused::redirectUri('An http redirect URI is only allowed on this computer (127.0.0.1, [::1] or localhost); use https elsewhere.');
            }

            return;
        }

        $this->checkAppScheme($scheme, $host);
    }

    private function checkAppScheme(string $scheme, string $host): void
    {
        if (\in_array($scheme, self::FORBIDDEN_SCHEMES, true) || $scheme === $this->ownScheme) {
            throw ClientRegistrationRefused::redirectUri(\sprintf('The scheme "%s" cannot be used as a redirect URI.', $scheme));
        }

        $dotted = '/^[a-z0-9](?:[a-z0-9-]*[a-z0-9])?(?:\.[a-z0-9](?:[a-z0-9-]*[a-z0-9])?)+$/';
        $reverseDomainScheme = 1 === preg_match($dotted, $scheme);
        $appWithDottedHost = 1 === preg_match('/^[a-z][a-z0-9-]*$/', $scheme) && 1 === preg_match($dotted, $host);
        if (!$reverseDomainScheme && !$appWithDottedHost) {
            throw ClientRegistrationRefused::redirectUri(\sprintf('The scheme "%s" does not name an app: use a reverse-domain scheme such as com.example.app:/callback, or a scheme with a dotted host such as %s://example.app/callback.', $scheme, $scheme));
        }
    }
}
