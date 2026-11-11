<?php

declare(strict_types=1);

namespace App\ApiResource\Input\Calendar;

use Symfony\Component\Validator\Constraints as Assert;

/** The user's private note on an event or one occurrence; empty removes it. */
final class EventNoteInput
{
    #[Assert\Regex('/^\d{8}(T\d{6}Z)?$/')]
    public ?string $recurrenceId = null;

    /**
     * At most {@see \App\Entity\EventNote::MAX_LENGTH} characters, or as long as the stored note (two notes joined
     * when their occurrences met may be longer), checked when it is saved. This bound only caps the request.
     */
    #[Assert\Length(max: 1048576)]
    public string $text = '';
}
