<?php

declare(strict_types=1);

namespace App\Security\OAuth;

use App\Deployment\PublicAddresses;
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

    /** "tresso" in a skeleton; \x01 is a character that reads as e or o. */
    private const string TRESSO = '/tr[e\x{1}]ss[o\x{1}]/u';

    private const array LOOPBACK_HOSTS = ['127.0.0.1', '[::1]', '::1', 'localhost'];

    /** @var list<string> */
    private array $domains;

    private string $ownScheme;

    public function __construct(
        PublicAddresses $addresses,
        #[Autowire(env: 'WEB_APP_URL')]
        string $webAppUrl,
        #[Autowire(env: 'NATIVE_REDIRECT_URI')]
        string $nativeRedirectUri,
    ) {
        $domains = self::DOMAINS;
        foreach ([$addresses->api(), $addresses->auth(), $addresses->mcp(), $webAppUrl] as $url) {
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
            if (1 === preg_match(self::TRESSO, self::collapse((string) preg_replace('/[^\p{L}\p{N}\x{1}]+/u', '', self::skeleton($label))))) {
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
     * lower case, digits and letters that look alike merged, long runs shortened), so Tress0, Trezzo or Tr€sso count.
     *
     * Separators do not hide it: the words are read as one. Inside one word it always counts (MyTresso). Across
     * separators it only does not count when it starts at least three letters into a word, as in Fortress Office or
     * Mattress Sort, where an ordinary word happens to end on its first letters; xT r e s s o, MyTres so and Mytr ess o
     * count.
     */
    public function namesTresso(string $name): bool
    {
        $words = preg_split('/[^\p{L}\p{N}\x{1}]+/u', self::skeleton($name), -1, \PREG_SPLIT_NO_EMPTY);
        if (false === $words) {
            return false;
        }

        // Every letter of the words read as one, with where it came from; long runs shortened across words too.
        $letters = [];
        foreach ($words as $index => $word) {
            if (1 === preg_match(self::TRESSO, $word)) {
                return true;
            }
            foreach (mb_str_split($word) as $offset => $letter) {
                $count = \count($letters);
                if ($count >= 2 && $letters[$count - 1][0] === $letter && $letters[$count - 2][0] === $letter) {
                    continue;
                }
                $letters[] = [$letter, $index, $offset];
            }
        }

        $joined = implode('', array_column($letters, 0));
        if (false === preg_match_all(self::TRESSO, $joined, $matches, \PREG_OFFSET_CAPTURE)) {
            return false;
        }
        foreach ($matches[0] as [, $byteOffset]) {
            $at = mb_strlen(substr($joined, 0, $byteOffset));
            if ($letters[$at][2] < 3) {
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

    /**
     * Lower-case ASCII with look-alikes merged; separators stay, so callers decide what spans words. A character that
     * reads as either e or o (℮) becomes \x01, which {@see self::TRESSO} takes for both.
     */
    private static function skeleton(string $text): string
    {
        // Letters and symbols that look like others but that Latin-ASCII keeps or drops.
        $folded = strtr(self::fold($text), [
            'ƨ' => 's', 'Ƨ' => 's', 'ſ' => 's', 'ꜱ' => 's', 'ı' => 'l', 'ʀ' => 'r', 'ᴛ' => 't', 'ᴇ' => 'e', 'ᴏ' => 'o',
            '€' => 'e', 'ɘ' => 'e', 'ǝ' => 'e', 'Ǝ' => 'e', '°' => 'o', 'ᴑ' => 'o', 'ᴓ' => 'o', 'ɵ' => 'o', 'ɔ' => 'o',
            'Ɔ' => 'o', '℮' => "\x01",
        ]);
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
