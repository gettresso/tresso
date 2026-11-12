<?php

declare(strict_types=1);

namespace App\Chat;

/**
 * Times of chats as the database keeps them: in the default zone (the columns have none) and to the second (as they are
 * stored), so a time held in memory compares as the one read back.
 */
final class ChatTime
{
    /**
     * How far ahead of the server a time from a client may lie: a phone or Mac whose clock is a little off is fine, a
     * time days ahead would keep a chat on top or mark later messages read.
     */
    public const string MAX_AHEAD = '+1 day';

    /** Before WhatsApp existed: a time this old is a broken clock or an unset value, never a message. */
    public const string EARLIEST = '2009-01-01T00:00:00+00:00';

    public static function stored(\DateTimeImmutable $time): \DateTimeImmutable
    {
        $time = $time->setTimezone(new \DateTimeZone(date_default_timezone_get()));

        return $time->setTime((int) $time->format('H'), (int) $time->format('i'), (int) $time->format('s'));
    }

    /** The later of two times; null is earlier than any time. */
    public static function later(?\DateTimeImmutable $a, \DateTimeImmutable $b): \DateTimeImmutable
    {
        return null === $a || $b > $a ? $b : $a;
    }
}
