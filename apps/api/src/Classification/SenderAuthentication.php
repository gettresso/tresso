<?php

declare(strict_types=1);

namespace App\Classification;

/**
 * Whether the receiving server vouches for the From domain: DMARC passed according to an Authentication-Results
 * header that server surely wrote (see {@see ReceivingServers}). Then the From domain sent the message, so its
 * headers (List-Unsubscribe among them) are the sender's own and rules about that sender can be trusted.
 *
 * The header is read as RFC 8601 results, not searched as text: comments and quoted strings hold what the sender
 * chose (the envelope sender, the claims of an ARC set), so only a result entry `dmarc=pass` counts.
 */
final class SenderAuthentication
{
    public static function dmarcPassed(?string $authenticationResults, bool $trusted): bool
    {
        if (!$trusted || null === $authenticationResults) {
            return false;
        }
        foreach (self::entries($authenticationResults) as $entry) {
            if (1 === preg_match('/^dmarc\s*=\s*pass(?:\s|$)/', $entry)) {
                return true;
            }
        }

        return false;
    }

    /**
     * The authserv-id the header starts with (the host that wrote it), or null when it starts with a result, as
     * Microsoft's does.
     */
    public static function authservId(string $authenticationResults): ?string
    {
        $first = self::entries($authenticationResults)[0] ?? '';
        if ('' === $first || str_contains($first, '=')) {
            return null;
        }

        // An optional version number follows the id (RFC 8601 2.2).
        return preg_split('/\s+/', $first)[0] ?? null;
    }

    /**
     * The entries of the header, lower case, without comments and quoted strings, trimmed.
     *
     * @return list<string>
     */
    private static function entries(string $authenticationResults): array
    {
        $value = strtolower($authenticationResults);
        // Comments nest (RFC 5322 3.2.2): take the innermost away until none is left.
        do {
            $value = preg_replace('/\((?:[^()\\\\]|\\\\.)*\)/', ' ', $value, -1, $count) ?? '';
        } while ($count > 0);
        $value = preg_replace('/"(?:[^"\\\\]|\\\\.)*"/', ' ', $value) ?? '';

        return array_values(array_filter(array_map(trim(...), explode(';', $value)), static fn (string $entry): bool => '' !== $entry));
    }
}
