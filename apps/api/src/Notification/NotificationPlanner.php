<?php

declare(strict_types=1);

namespace App\Notification;

use App\Calendar\ICalendar\CalendarDocument;
use App\Calendar\ICalendar\InvalidCalendarData;
use App\Calendar\ICalendar\Occurrences;
use App\Calendar\ICalendar\RecurrenceKey;
use App\Calendar\SelfAddresses;
use App\Entity\CalendarEvent;
use App\Entity\CalendarObject;
use App\Entity\NotificationPreferences;
use App\Entity\ReminderRule;
use App\Entity\ScheduledNotification;
use App\Entity\User;
use App\Enum\EventStatus;
use App\Enum\NotificationKind;
use App\Enum\ParticipationStatus;
use App\Notification\Travel\TravelTimeEstimator;
use App\Realtime\AfterCommitDispatcher;
use App\Repository\CalendarEventRepository;
use App\Repository\NotificationPreferencesRepository;
use App\Repository\ScheduledNotificationRepository;
use Doctrine\ORM\EntityManagerInterface;
use Psr\Log\LoggerInterface;
use Sabre\VObject\Component\VEvent;
use Sabre\VObject\Recur\MaxInstancesExceededException;
use Symfony\Component\Messenger\Stamp\DelayStamp;

/**
 * Turns events into planned notifications for the occurrences of the coming days: the event's own reminders (or the
 * user's default rule when it has none), leave-now, the brief before a meeting and the follow-up after it. Plans
 * are recomputed whenever an event or the user's settings change; a delivered notification is never planned again.
 * Every new or moved plan is announced as a delayed message for its fire time. Runs inside the caller's transaction.
 */
final readonly class NotificationPlanner
{
    public const string HORIZON = 'P8D';
    /**
     * Leave-now without a set travel time waits for the phone's estimate from this long before the start (the phone
     * reads its position from then on), and is moved to the moment to leave when one comes.
     */
    public const int LEAVE_CHECK_MINUTES = 60;
    public const string LEAVE_ESTIMATED_SLOT = 'leave:estimated';
    /** Plans this far in the past are left out: too late to matter. */
    private const string TOO_LATE = '-2 minutes';
    /** Occurrences one series is planned for within the horizon: an hourly series has under 250. */
    private const int MAX_PER_SERIES = 500;

    public function __construct(
        private EntityManagerInterface $entityManager,
        private CalendarEventRepository $events,
        private ScheduledNotificationRepository $notifications,
        private NotificationPreferencesRepository $preferences,
        private ReminderRules $rules,
        private SelfAddresses $selfAddresses,
        private AfterCommitDispatcher $afterCommit,
        private TravelTimeEstimator $travel,
        private LoggerInterface $logger,
    ) {
    }

    public function planUser(User $user, \DateTimeImmutable $now): void
    {
        $preferences = $this->preferences->forUser($user);
        $until = $now->add(new \DateInterval(self::HORIZON));
        $context = $this->context($user, $preferences);

        foreach ($this->events->objectsInRange($user, [], $now->modify('-1 day'), $until) as $object) {
            $this->planWithin($object, $now, $until, $context);
        }
        foreach ($this->notifications->findOrphans($user) as $orphan) {
            $this->entityManager->remove($orphan);
        }
        $preferences->setPlannedUntil($until);
        $this->entityManager->flush();
    }

    public function planObject(CalendarObject $object, \DateTimeImmutable $now): void
    {
        $user = $object->getCalendar()->getOwner();
        $preferences = $this->preferences->forUser($user);
        $until = max($preferences->getPlannedUntil() ?? $now, $now->add(new \DateInterval(self::HORIZON)));
        $this->planWithin($object, $now, $until, $this->context($user, $preferences));
        $this->entityManager->flush();
    }

    public function removeOrphans(User $user): void
    {
        foreach ($this->notifications->findOrphans($user) as $orphan) {
            $this->entityManager->remove($orphan);
        }
        $this->entityManager->flush();
    }

    /**
     * Announces a notification for its fire time.
     */
    public function announce(ScheduledNotification $notification): void
    {
        $this->afterCommit->dispatch(new FireNotification($notification->getId()->toRfc4122()), [DelayStamp::delayUntil($notification->getFireAt())]);
    }

    /**
     * The user's channels for a kind, else its default: leave now on the phone, briefs and follow-ups on the desktop.
     *
     * @return list<string>
     */
    private static function channels(PlanContext $context, NotificationKind $kind): array
    {
        return $context->preferences->channelsFor($kind->value, $kind->defaultChannels())->values();
    }

    private function context(User $user, NotificationPreferences $preferences): PlanContext
    {
        return new PlanContext(
            $user,
            new \DateTimeZone($preferences->getTimeZone()),
            $this->rules->of($user),
            $this->selfAddresses->of($user),
            $preferences,
        );
    }

    private function planWithin(CalendarObject $object, \DateTimeImmutable $now, \DateTimeImmutable $until, PlanContext $context): void
    {
        $rows = $this->events->findForObject($object);
        $existing = $this->notifications->findPlannedFor(array_values($rows));

        $wanted = [];
        if ($object->getCalendar()->isVisible()) {
            try {
                foreach (Occurrences::instances(CalendarDocument::parse($object->getIcal()), $now->modify('-1 day'), $until, $context->zone, self::MAX_PER_SERIES) as $source => $instance) {
                    $key = CalendarDocument::recurrenceKey($instance);
                    // The row the occurrence takes its fields from: its own override, one changing this and future
                    // occurrences, or the series.
                    $row = $rows[$source] ?? $rows[''] ?? null;
                    if (null === $row) {
                        continue;
                    }
                    foreach ($this->plansFor($row, $key, $instance, $context, $now) as $plan) {
                        $wanted[$plan->key($row)] = [$row, $plan];
                    }
                }
            } catch (MaxInstancesExceededException|\Sabre\VObject\InvalidDataException|InvalidCalendarData $e) {
                $this->logger->warning('Notifications could not be planned', ['object' => $object->getId()->toRfc4122(), 'error' => $e->getMessage()]);
            }
        }

        // An occurrence whose source row changed (an override, or one for this and future occurrences, appeared or
        // went) keeps its notification: its snooze, hold and deliveries go along to the new row.
        $previous = [];
        foreach ($existing as $key => $notification) {
            if (!isset($wanted[$key])) {
                $previous[self::occurrenceSlot($notification->getOccurrenceKey(), $notification->getKind(), $notification->getSlot())] = $key;
            }
        }

        $tooLate = $now->modify(self::TOO_LATE);
        foreach ($wanted as $key => [$row, $plan]) {
            $notification = $existing[$key] ?? null;
            unset($existing[$key]);
            $moved = $previous[self::occurrenceSlot($plan->occurrenceKey, $plan->kind, $plan->slot)] ?? null;
            if (null === $notification && null !== $moved && isset($existing[$moved])) {
                $notification = $existing[$moved];
                unset($existing[$moved]);
                $notification->moveTo($row);
            }
            if (null !== $notification) {
                $estimate = $notification->getEstimatedMinutes();
                if (self::LEAVE_ESTIMATED_SLOT === $plan->slot && null !== $estimate) {
                    // The phone's estimate stays until it sends another.
                    $plan = new Plan($plan->occurrenceKey, $plan->kind, $plan->slot, self::leaveAt($plan->startsAt, $estimate, $context), $plan->startsAt, $plan->title, self::leaveBody($estimate, trim($row->getLocation())), $plan->channels, $plan->occurrenceStart);
                }
                if ($notification->isDelivered()) {
                    // The occurrence moved after its notification came: a new round for the new time, if still ahead.
                    // Not when only the user's zone changed (an all-day or floating occurrence keeps its start).
                    if ($plan->occurrenceStart !== $notification->getOccurrenceStart() && $plan->fireAt > $now) {
                        $notification->restart($plan->fireAt, $plan->startsAt, $plan->occurrenceStart, $plan->title, $plan->body, $plan->channels);
                        $this->announce($notification);
                    }
                    continue;
                }
                $held = $notification->getHeldUntil();
                if (null !== $held && NotificationKind::FollowUp !== $plan->kind && $plan->startsAt != $notification->getOccurrenceStartsAt() && $held > $plan->startsAt) {
                    // Snoozed or postponed past where the occurrence now starts: that time is meaningless now. A
                    // reminder whose own time has passed comes at once, while the occurrence is still ahead.
                    $notification->releaseHold();
                    if ($plan->fireAt < $now && $plan->startsAt > $now) {
                        $plan = $plan->firingAt($now);
                    }
                }
                if ($notification->replan($plan->fireAt, $plan->startsAt, $plan->occurrenceStart, $plan->title, $plan->body, $plan->channels)) {
                    if ($notification->getFireAt() < $tooLate) {
                        // Moved into the past: too late to matter, as a new plan would be.
                        $this->entityManager->remove($notification);
                        continue;
                    }
                    $this->announce($notification);
                }
                continue;
            }
            if ($plan->fireAt < $tooLate) {
                continue;
            }
            $notification = new ScheduledNotification($context->user, $row, $plan->occurrenceKey, $plan->kind, $plan->slot, $plan->fireAt, $plan->startsAt, $plan->occurrenceStart, $plan->title, $plan->body, $plan->channels);
            $this->entityManager->persist($notification);
            $this->announce($notification);
        }

        foreach ($existing as $stale) {
            if (!$stale->isDelivered()) {
                $this->entityManager->remove($stale);
            }
        }
    }

    /**
     * @return list<Plan>
     */
    private function plansFor(CalendarEvent $row, string $key, VEvent $instance, PlanContext $context, \DateTimeImmutable $now): array
    {
        if (EventStatus::Cancelled === $row->getStatus() || ParticipationStatus::Declined === $row->getSelfPartstat()) {
            return [];
        }
        $start = Props::instant($instance, 'DTSTART', $context->zone);
        if (null === $start) {
            return [];
        }
        // DTEND, else DURATION (instances of a series keep the master's), read as the start is.
        $endOf = Occurrences::endOf($instance, $context->zone);
        $end = $row->isAllDay()
            ? new \DateTimeImmutable($endOf->format('Y-m-d'), $context->zone)->setTimezone(new \DateTimeZone('UTC'))
            : $endOf->setTimezone(new \DateTimeZone('UTC'));

        $occurrenceStart = Props::start($instance);
        $rule = ReminderRules::match($context->rules, $row, $context->self);
        $title = '' === $row->getSummary() ? '(no title)' : $row->getSummary();
        $plans = [];

        $shiftEarly = $context->preferences->isShiftEarlyReminders() && $row->getCalendar()->isWork() && !$row->isAllDay();
        foreach ($this->reminders($row, $rule, $start, $end, $context) as $slot => [$fireAt, $channels]) {
            if ($shiftEarly) {
                $fireAt = WorkingHours::shiftEarly($context->preferences, $fireAt, $start) ?? $fireAt;
            }
            $plans[] = new Plan($key, NotificationKind::Reminder, $slot, $fireAt, $start, $title, self::reminderBody($row, $start, $end, $context->zone), $channels, $occurrenceStart);
        }

        $location = trim($row->getLocation());
        $others = ReminderRules::hasOthers($row, $context->self);
        if ($context->preferences->isLeaveNow() && !$row->isAllDay() && '' !== $location && (null !== $row->getTravelMinutes() || true === $rule?->isLeaveNow())) {
            $travel = $row->getTravelMinutes();
            if (null !== $travel) {
                $plans[] = new Plan($key, NotificationKind::LeaveNow, 'leave', self::leaveAt($start, $travel, $context), $start, $title, self::leaveBody($travel, $location), self::channels($context, NotificationKind::LeaveNow), $occurrenceStart);
            } elseif ($this->travel->isAvailable($context->preferences->getTravelMode())) {
                // Waits for the phone's estimate, and is moved to the moment to leave when it comes.
                $plans[] = new Plan($key, NotificationKind::LeaveNow, self::LEAVE_ESTIMATED_SLOT, $start->modify(\sprintf('-%d minutes', self::LEAVE_CHECK_MINUTES)), $start, $title, self::leaveBody(null, $location), self::channels($context, NotificationKind::LeaveNow), $occurrenceStart);
            }
        }
        if ($others && null !== $rule?->getBriefMinutes()) {
            $plans[] = new Plan($key, NotificationKind::Brief, 'brief', $start->modify(\sprintf('-%d minutes', $rule->getBriefMinutes())), $start, 'Brief: '.$title, 'Who is coming and what you discussed.', self::channels($context, NotificationKind::Brief), $occurrenceStart);
        }
        if ($others && !$row->isAllDay() && true === $rule?->isFollowUp() && $end > $now->modify('-1 hour')) {
            $plans[] = new Plan($key, NotificationKind::FollowUp, 'follow', $end, $start, 'After: '.$title, 'How did it go? Add notes or follow-ups while it is fresh.', self::channels($context, NotificationKind::FollowUp), $occurrenceStart);
        }

        return $plans;
    }

    private static function occurrenceSlot(string $occurrenceKey, NotificationKind $kind, string $slot): string
    {
        return implode('|', [$occurrenceKey, $kind->value, $slot]);
    }

    /**
     * The event's own reminders, or its rule's when it uses the defaults.
     *
     * @return array<string, array{\DateTimeImmutable, list<string>}> by slot
     */
    private function reminders(CalendarEvent $row, ?ReminderRule $rule, \DateTimeImmutable $start, \DateTimeImmutable $end, PlanContext $context): array
    {
        $reminders = [];
        if ($row->usesDefaultReminders()) {
            foreach ($rule?->getReminders() ?? [] as $index => $reminder) {
                if (null !== $reminder['dayBeforeAt']) {
                    [$hour, $minute] = array_map(intval(...), explode(':', $reminder['dayBeforeAt']));
                    $fireAt = $start->setTimezone($context->zone)->modify('-1 day')->setTime($hour, $minute);
                } else {
                    $fireAt = $start->modify(\sprintf('-%d minutes', $reminder['minutesBefore'] ?? 0));
                }
                $reminders['rule:'.$index] = [$fireAt, $reminder['channels']];
            }

            return $reminders;
        }

        foreach ($row->getReminders() as $index => $reminder) {
            if (null !== $reminder['at']) {
                $fireAt = RecurrenceKey::toDateTime($reminder['at']);
            } else {
                $fireAt = self::offset('end' === $reminder['relatedTo'] ? $end : $start, (string) $reminder['trigger']);
            }
            if (false === $fireAt || null === $fireAt) {
                continue;
            }
            $reminders['valarm:'.$index] = [$fireAt, $reminder['channels']];
        }

        return $reminders;
    }

    /** Applies an iCalendar duration like -PT15M or P1D to a moment. */
    private static function offset(\DateTimeImmutable $base, string $duration): ?\DateTimeImmutable
    {
        $negative = str_starts_with($duration, '-');
        try {
            $interval = new \DateInterval(ltrim($duration, '+-'));
        } catch (\Exception) {
            return null;
        }

        return $negative ? $base->sub($interval) : $base->add($interval);
    }

    private static function reminderBody(CalendarEvent $row, \DateTimeImmutable $start, \DateTimeImmutable $end, \DateTimeZone $zone): string
    {
        $when = $row->isAllDay()
            ? $start->setTimezone($zone)->format('l j F').' (all day)'
            : $start->setTimezone($zone)->format('l j F, H:i').' to '.$end->setTimezone($zone)->format('H:i');
        $location = trim($row->getLocation());

        return '' === $location ? $when : $when.', '.$location;
    }

    /** When to leave: the travel time and the user's extra time before the start. */
    public static function leaveAt(\DateTimeImmutable $start, int $travelMinutes, PlanContext $context): \DateTimeImmutable
    {
        return $start->modify(\sprintf('-%d minutes', $travelMinutes + $context->preferences->getExtraTravelMinutes()));
    }

    public static function leaveBody(?int $travelMinutes, string $location): string
    {
        return null === $travelMinutes
            ? \sprintf('Time to leave for %s.', $location)
            : \sprintf('Leave now: about %d minutes to %s.', $travelMinutes, $location);
    }
}
