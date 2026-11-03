<?php

declare(strict_types=1);

namespace App\Security\OAuth;

use Symfony\Component\DependencyInjection\Attribute\Autowire;

/**
 * What an app that is not ours may not use, so that it cannot pass itself off as Tresso on the consent screen or in
 * the connected apps list: Tresso's domains (and this server's own hosts), any host or scheme with a label that has
 * "tresso" in it (`login-tresso.app`, `gettresso.co`, `app.tresso.mobile`), and names that read "Tresso", also when
 * written with look-alike letters or digits.
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

    /** A Tresso domain or a host under one, or any host with a label that has "tresso" in it. */
    public function isTressoHost(string $host): bool
    {
        $host = rtrim(strtolower($host), '.');
        foreach (explode('.', $host) as $label) {
            if (str_contains($label, 'tresso')) {
                return true;
            }
        }
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

        return $scheme === $this->ownScheme || $this->isTressoHost(implode('.', array_reverse(explode('.', $scheme))));
    }

    /**
     * Whether a name reads "Tresso": compared as a skeleton (compatibility forms such as 𝐓𝐫𝐞𝐬𝐬𝐨 folded, accents dropped,
     * lower case, digits and letters that look alike merged, long runs shortened), so Tress0, Trezzo or Tréssø count.
     */
    public function namesTresso(string $name): bool
    {
        return str_contains(self::skeleton($name), 'tresso');
    }

    /**
     * Whether a name only uses Latin letters and the characters every script shares (digits, punctuation, symbols,
     * combining marks), after folding compatibility forms. Letters from other scripts can look exactly like Latin ones
     * (Cyrillic ѕ, Cherokee Ꭲ), so a name could read as one it is not.
     */
    public static function isLatin(string $name): bool
    {
        return 1 === preg_match('/^[\p{Latin}\p{Common}\p{Inherited}]*$/u', self::fold($name));
    }

    private static function fold(string $name): string
    {
        $folded = \Normalizer::normalize($name, \Normalizer::FORM_KC);

        return \is_string($folded) ? $folded : $name;
    }

    private static function skeleton(string $name): string
    {
        $ascii = transliterator_transliterate('Latin-ASCII; Lower()', self::fold($name));
        $skeleton = strtr(false === $ascii ? mb_strtolower(self::fold($name)) : $ascii, [
            '0' => 'o', '1' => 'l', 'i' => 'l', '|' => 'l', '!' => 'l', '3' => 'e', '4' => 'a', '@' => 'a',
            '5' => 's', '$' => 's', 'z' => 's', '2' => 's', '7' => 't', '+' => 't', '8' => 'b',
        ]);

        // Three or more of the same letter read like two: Tressso.
        return (string) preg_replace('/(.)\1{2,}/', '$1$1', $skeleton);
    }
}
