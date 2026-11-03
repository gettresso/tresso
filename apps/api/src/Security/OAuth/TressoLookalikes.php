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

    /**
     * A Tresso domain or a host under one, or any host with a label that reads "tresso" somewhere, compared as a
     * skeleton without hyphens: tress0.com, tre55o.com and tres-so.app count.
     */
    public function isTressoHost(string $host): bool
    {
        $host = rtrim(strtolower($host), '.');
        foreach (explode('.', $host) as $label) {
            if (str_contains(self::collapse((string) preg_replace('/[^\p{L}\p{N}]+/u', '', self::skeleton($label))), 'tresso')) {
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
     * Whether a name reads "Tresso", compared as a skeleton (compatibility forms such as 𝐓𝐫𝐞𝐬𝐬𝐨 folded, accents dropped,
     * lower case, digits and letters that look alike merged, long runs shortened), so Tress0, Trezzo or Tréssø count.
     * It counts inside a word (MyTresso), and across spaces, dots, hyphens and other separators when it starts a word
     * (T r e s s o, Tres-so), but not when a word only ends on its first letters (Fortress Office).
     */
    public function namesTresso(string $name): bool
    {
        $words = preg_split('/[^\p{L}\p{N}]+/u', self::skeleton($name), -1, \PREG_SPLIT_NO_EMPTY);
        if (false === $words) {
            return false;
        }
        foreach ($words as $index => $word) {
            if (str_contains($word, 'tresso') || str_starts_with(self::collapse(implode('', \array_slice($words, $index))), 'tresso')) {
                return true;
            }
        }

        return false;
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

    /** Lower-case ASCII with look-alikes merged; separators stay, so callers decide what spans words. */
    private static function skeleton(string $text): string
    {
        // Latin letters that look like others but that Latin-ASCII keeps or drops.
        $folded = strtr(self::fold($text), ['ƨ' => 's', 'Ƨ' => 's', 'ſ' => 's', 'ı' => 'l']);
        $ascii = transliterator_transliterate('Latin-ASCII; Lower()', $folded);
        $skeleton = strtr(false === $ascii ? mb_strtolower($folded) : $ascii, [
            '0' => 'o', '1' => 'l', 'i' => 'l', '|' => 'l', '!' => 'l', '3' => 'e', '4' => 'a', '@' => 'a',
            '5' => 's', '$' => 's', 'z' => 's', '2' => 's', '7' => 't', '+' => 't', '8' => 'b',
        ]);

        return self::collapse($skeleton);
    }

    /** Three or more of the same letter read like two: Tressso. */
    private static function collapse(string $text): string
    {
        return (string) preg_replace('/(.)\1{2,}/u', '$1$1', $text);
    }
}
