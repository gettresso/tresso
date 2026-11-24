<?php

declare(strict_types=1);

namespace App\Account\Import;

/**
 * What counts as an address of an import list, the same rule as `readPastedAddresses` in packages/core (the cases both
 * check are in tests/Fixtures/import-addresses.json):
 *
 * - at most 320 characters, one `@`, a local part of 1 to 64 characters of letters, digits and
 *   ``.!#$%&'*+/=?^_`{|}~-``, without a dot at its start or end or two in a row;
 * - a domain of at least two labels, each 1 to 63 letters, digits or hyphens without a hyphen at its start or end, and
 *   a top-level label of letters only, at most 253 characters once written in ASCII.
 *
 * An address is lowercased and its domain written in ASCII (punycode), the way it is stored and compared. A list an
 * app made (not one of Tresso's own) takes only addresses whose domain is plain ASCII and whose local part keeps to one
 * script: `kim@gmaіl.com` with a Cyrillic letter looks like Gmail, and its lookup would ask the attacker's domain for
 * the server the password goes to.
 */
final class ImportAddress
{
    private const string LOCAL = "/^[\\p{L}\\p{N}!#$%&'*+\\/=?^_`{|}~-]+(\\.[\\p{L}\\p{N}!#$%&'*+\\/=?^_`{|}~-]+)*$/u";
    private const string LABEL = '/^[\p{L}\p{N}](?:[\p{L}\p{N}-]*[\p{L}\p{N}])?$/u';
    private const string TOP = '/^(?:\p{L}+|xn--[a-z0-9-]+)$/u';

    /**
     * The address as stored, or null when it is not one (for this kind of list).
     *
     * @param bool $firstParty made in Tresso's own apps rather than by an app or a token
     */
    public static function normalize(string $input, bool $firstParty): ?string
    {
        $address = mb_strtolower(trim($input));
        if ('' === $address || mb_strlen($address) > 320 || 1 !== substr_count($address, '@')) {
            return null;
        }
        [$local, $domain] = explode('@', $address);
        if ('' === $local || mb_strlen($local) > 64 || 1 !== preg_match(self::LOCAL, $local)) {
            return null;
        }
        $labels = explode('.', $domain);
        if (\count($labels) < 2) {
            return null;
        }
        foreach ($labels as $label) {
            if (mb_strlen($label) > 63 || 1 !== preg_match(self::LABEL, $label)) {
                return null;
            }
        }
        if (1 !== preg_match(self::TOP, (string) end($labels))) {
            return null;
        }

        $ascii = 1 === preg_match('/^[\x20-\x7e]*$/', $domain);
        if (!$firstParty && (!$ascii || self::mixesScripts($local))) {
            return null;
        }
        if (!$ascii) {
            $converted = idn_to_ascii($domain, \IDNA_NONTRANSITIONAL_TO_ASCII, \INTL_IDNA_VARIANT_UTS46);
            if (false === $converted) {
                return null;
            }
            $domain = $converted;
        }
        if (\strlen($domain) > 253 || \strlen($local) + 1 + \strlen($domain) > 320) {
            return null;
        }

        return $local.'@'.$domain;
    }

    /**
     * Whether a list an app made leaves the address out for its letters alone: an address in a list made in Tresso, but
     * with a domain that is not plain ASCII or a local part that mixes scripts.
     */
    public static function isLookalike(string $input): bool
    {
        return null !== self::normalize($input, true) && null === self::normalize($input, false);
    }

    /** Whether the text holds letters of more than one script (Latin and Cyrillic, say). */
    private static function mixesScripts(string $text): bool
    {
        $scripts = [];
        foreach (mb_str_split($text) as $character) {
            $script = \IntlChar::getIntPropertyValue($character, \IntlChar::PROPERTY_SCRIPT);
            // Common (digits, punctuation) and Inherited (combining marks) go with any script.
            if (\in_array($script, [0, 1], true)) {
                continue;
            }
            $scripts[$script] = true;
        }

        return \count($scripts) > 1;
    }
}
