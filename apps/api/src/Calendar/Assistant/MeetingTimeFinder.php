<?php

declare(strict_types=1);

namespace App\Calendar\Assistant;

use App\Calendar\TooManyOccurrences;
use App\Entity\User;

/**
 * Proposes times for a meeting or a todo. The built-in finder finds them deterministically in the user's own
 * calendars within their working hours and scheduling preferences ({@see DeterministicMeetingTimeFinder}); a planned AI
 * feature would decorate it to add attendees' availability or rank by habits.
 */
interface MeetingTimeFinder
{
    /**
     * @param \DateTimeImmutable $now the moment the minimum notice counts from
     *
     * @throws TooManyOccurrences when the calendars hold too much in the window to look through
     */
    public function find(User $user, MeetingTimeQuery $query, \DateTimeImmutable $now): MeetingTimes;

    /** Whether attendees' busy time can be known, so clients can say whether proposals suit everyone. */
    public function knowsAttendeeAvailability(): bool;
}
