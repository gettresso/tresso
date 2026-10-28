<?php

declare(strict_types=1);

namespace App\Calendar\Assistant;

use App\Entity\User;
use Symfony\Component\DependencyInjection\Attribute\AutoconfigureTag;

/**
 * Where the meeting time finder learns when attendees are busy: a provider's free/busy (Google, Microsoft Graph,
 * CalDAV scheduling), or what an AI version knows. Tresso has none built in, so attendees' availability is unknown
 * and only the user's own time counts.
 */
#[AutoconfigureTag(self::TAG)]
interface AttendeeAvailabilitySource
{
    public const string TAG = 'app.calendar.attendee_availability_source';

    /**
     * What this source knows of the attendees' time in [$from, $to), by address: their busy time and, where known,
     * their working hours. Attendees it knows nothing of are left out (an attendee it knows to be free has no busy time).
     *
     * @param list<string> $addresses lower case
     *
     * @return array<string, AttendeeAvailability>
     */
    public function busyTimes(User $user, array $addresses, \DateTimeImmutable $from, \DateTimeImmutable $to): array;
}
