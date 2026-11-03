<?php

declare(strict_types=1);

namespace App\Security\OAuth;

use Symfony\Component\DependencyInjection\Attribute\Autowire;

/**
 * What an app that is not ours may not use, so that it cannot pass itself off as Tresso on the consent screen or in
 * the connected apps list: Tresso's domains (and this server's own hosts), schemes that are such a domain reversed or
 * name Tresso (such as `app.tresso.mobile`, which our mobile app uses), and names that read "Tresso", also when written
 * with look-alike letters from another script.
 */
final readonly class TressoLookalikes
{
    public const array DOMAINS = ['tresso.app', 'gettresso.com'];

    private const array LOOPBACK_HOSTS = ['127.0.0.1', '[::1]', '::1', 'localhost'];

    /** @var list<string> */
    private array $domains;

    private string $ownScheme;

    public function __construct(
        #[Autowire(env: 'API_PUBLIC_URL')]
        string $apiPublicUrl,
        #[Autowire(env: 'WEB_APP_URL')]
        string $webAppUrl,
        #[Autowire(env: 'NATIVE_REDIRECT_URI')]
        string $nativeRedirectUri,
    ) {
        $domains = self::DOMAINS;
        foreach ([$apiPublicUrl, $webAppUrl] as $url) {
            $host = strtolower((string) parse_url($url, \PHP_URL_HOST));
            if ('' !== $host && !\in_array($host, self::LOOPBACK_HOSTS, true)) {
                $domains[] = $host;
            }
        }
        $this->domains = array_values(array_unique($domains));
        $this->ownScheme = strtolower((string) parse_url($nativeRedirectUri, \PHP_URL_SCHEME));
    }

    public function isTressoHost(string $host): bool
    {
        $host = rtrim(strtolower($host), '.');
        foreach ($this->domains as $domain) {
            if ($host === $domain || str_ends_with($host, '.'.$domain)) {
                return true;
            }
        }

        return false;
    }

    /** Our own apps' scheme, a scheme with a label naming Tresso, or a Tresso domain reversed. */
    public function isTressoScheme(string $scheme): bool
    {
        $scheme = strtolower($scheme);
        if ($scheme === $this->ownScheme) {
            return true;
        }
        $labels = explode('.', $scheme);
        foreach ($labels as $label) {
            if (str_contains($label, 'tresso')) {
                return true;
            }
        }

        return $this->isTressoHost(implode('.', array_reverse($labels)));
    }

    /** Whether a name reads "Tresso", ignoring case and look-alike letters from other scripts. */
    public function namesTresso(string $name): bool
    {
        $latin = transliterator_transliterate('Any-Latin; Latin-ASCII; Lower()', $name);

        return str_contains(false === $latin ? mb_strtolower($name) : $latin, 'tresso');
    }
}
