<?php

declare(strict_types=1);

namespace App\Calendar\Assistant;

use App\Entity\Message;
use App\Entity\User;

/**
 * Finds events and deadlines in a message. The built-in extractor reads the message's text/calendar
 * parts ({@see CalendarPartEventExtractor}); an AI version decorates it to read the text as well.
 */
interface EventExtractor
{
    /** Whether events and deadlines are read from the message's text, not only from its calendar parts. */
    public function readsText(): bool;

    /**
     * @return array{events: list<ExtractedEvent>, deadlines: list<ExtractedDeadline>}
     */
    public function extract(User $user, Message $message): array;
}
