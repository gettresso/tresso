<?php

declare(strict_types=1);

namespace App\Calendar\Assistant;

use App\Calendar\SelfAddresses;
use App\Entity\User;
use App\Repository\NotificationPreferencesRepository;
use App\Repository\SchedulingPreferencesRepository;
use Symfony\Component\DependencyInjection\Attribute\AsAlias;
use Symfony\Component\DependencyInjection\Attribute\AutowireIterator;

/**
 * The built-in meeting time finder: the zone and working hours of the user's notification settings (the same
 * ones their reminders keep to), their scheduling preferences, busy time from every {@see BusyTimeSource} and
 * attendees' busy time from every {@see AttendeeAvailabilitySource}, searched by {@see SlotSearch}.
 */
#[AsAlias(MeetingTimeFinder::class)]
final readonly class DeterministicMeetingTimeFinder implements MeetingTimeFinder
{
    /**
     * @param iterable<BusyTimeSource>             $busySources
     * @param iterable<AttendeeAvailabilitySource> $attendeeSources
     */
    public function __construct(
        private NotificationPreferencesRepository $notificationPreferences,
        private SchedulingPreferencesRepository $preferences,
        private SelfAddresses $selfAddresses,
        #[AutowireIterator(BusyTimeSource::TAG)]
        private iterable $busySources,
        #[AutowireIterator(AttendeeAvailabilitySource::TAG)]
        private iterable $attendeeSources,
    ) {
    }

    public function find(User $user, MeetingTimeQuery $query, \DateTimeImmutable $now): MeetingTimes
    {
        $hours = $this->notificationPreferences->forUser($user);
        $preferences = $this->preferences->forUser($user);
        $zone = $query->timeZone ?? new \DateTimeZone($hours->getTimeZone());
        $rules = new SchedulingRules(
            $zone,
            WeeklyTime::workingHours($hours->getWorkDays(), $hours->getWorkStart(), $hours->getWorkEnd()),
            $preferences->getBufferMinutes(),
            $preferences->getTravelMinutes(),
            $preferences->getMinimumNoticeMinutes(),
        );

        // Busy time outside the window still keeps its buffer or travel time free inside it; an event names at most a
        // day of travel.
        $from = $query->from->modify('-1 day');
        $to = $query->to->modify('+1 day');

        $busy = [];
        foreach ($this->busySources as $source) {
            foreach ($source->busyTimes($user, $from, $to, $zone, $query->calendarIds) as $time) {
                $busy[] = $time;
            }
        }

        $self = $this->selfAddresses->of($user);
        $others = array_values(array_diff($query->attendeeAddresses(), $self));
        $attendeeBusy = [];
        if ([] !== $others) {
            foreach ($this->attendeeSources as $source) {
                foreach ($source->busyTimes($user, $others, $query->from, $query->to) as $address => $availability) {
                    if (\in_array($address, $others, true)) {
                        $attendeeBusy[$address] = [...$attendeeBusy[$address] ?? [], ...$availability->busyIn($query->from, $query->to)];
                    }
                }
            }
        }

        $availability = [];
        foreach ($query->attendeeAddresses() as $address) {
            // The user's own addresses are known: their busy time is the user's.
            $availability[$address] = \in_array($address, $self, true) || \array_key_exists($address, $attendeeBusy);
        }

        $result = SlotSearch::find($rules, $query, $now, $busy, $attendeeBusy);

        return new MeetingTimes($result->slots, $result->noSlotReason, $rules, $availability);
    }

    public function knowsAttendeeAvailability(): bool
    {
        foreach ($this->attendeeSources as $source) {
            return true;
        }

        return false;
    }
}
