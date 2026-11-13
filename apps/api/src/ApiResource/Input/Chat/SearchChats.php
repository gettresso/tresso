<?php

declare(strict_types=1);

namespace App\ApiResource\Input\Chat;

use App\Chat\ChatReader;
use Symfony\Component\Validator\Constraints as Assert;

/**
 * A search of the user's WhatsApp messages ({@see ChatReader::search()}), sent as a JSON body so the text searched for
 * never sits in a URL (proxy access logs, the request line of an error report).
 */
final class SearchChats
{
    /** Bytes a request may have: the text in four-byte characters, escaped, and the other fields. */
    public const int MAX_BYTES = 4096;

    /** Matched anywhere in a message's text, file name or sender name, ignoring case. Trimmed. */
    #[Assert\NotBlank(normalizer: 'trim', message: 'Give text to search for.')]
    #[Assert\Length(min: ChatReader::QUERY_MIN, max: ChatReader::QUERY_MAX, normalizer: 'trim')]
    #[Assert\Regex('/[\x00-\x1F\x7F]/', message: 'The search text cannot contain control characters.', match: false)]
    public string $q = '';

    /** How many days back; 30 when left out. */
    #[Assert\Range(min: 1, max: ChatReader::SEARCH_MAX_DAYS)]
    public ?int $days = null;

    /** Only this chat. */
    #[Assert\Uuid]
    public ?string $chatId = null;

    /** Results at most; 20 when left out. */
    #[Assert\Range(min: 1, max: ChatReader::SEARCH_MAX_LIMIT)]
    public ?int $limit = null;

    /** The `nextCursor` of the call before. */
    #[Assert\Length(max: 200)]
    public ?string $cursor = null;
}
