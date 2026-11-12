<?php

declare(strict_types=1);

namespace App\ApiResource\Output\Chat;

/**
 * What became of a batch of relayed messages: the counts, and per message (in the order of the request) `stored`,
 * `known` (the server had it, nothing changed), `left_out` (its chat is left out, or is a group while the account
 * leaves groups out; nothing stored) or `refused` (it carries something the relay cannot repair; nothing stored, see
 * {@see \App\Chat\ChatIngestor}).
 */
final readonly class RelayImportOutput
{
    public const string STORED = 'stored';
    public const string KNOWN = 'known';
    public const string LEFT_OUT = 'left_out';
    public const string REFUSED = 'refused';

    /**
     * @param list<self::STORED|self::KNOWN|self::LEFT_OUT|self::REFUSED> $results
     */
    public function __construct(
        public int $stored,
        public int $known,
        public int $leftOut,
        public int $refused,
        public array $results,
    ) {
    }
}
