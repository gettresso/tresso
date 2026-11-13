<?php

declare(strict_types=1);

namespace App\Notification;

use App\Entity\CalendarEvent;
use App\Entity\ReminderRule;
use App\Entity\User;
use App\Enum\RuleRole;
use App\Repository\ReminderRuleRepository;
use Doctrine\ORM\EntityManagerInterface;

/**
 * The user's default reminder rules: which one applies to an event, and the ones every user starts with.
 */
final readonly class ReminderRules
{
    public function __construct(
        private ReminderRuleRepository $rules,
        private EntityManagerInterface $entityManager,
    ) {
    }

    /**
     * New users: 10 minutes before timed events and 09:00 the day before all-day events, on the phone and desktop.
     */
    public function createDefaults(User $user): void
    {
        $timed = new ReminderRule($user, 'Timed events');
        $timed->match(null, false, RuleRole::Any, null, null, null);
        $timed->setReminders([['minutesBefore' => 10, 'dayBeforeAt' => null, 'channels' => ['phone', 'desktop']]]);
        $this->entityManager->persist($timed);

        $allDay = new ReminderRule($user, 'All-day events');
        $allDay->match(null, true, RuleRole::Any, null, null, null);
        $allDay->setReminders([['minutesBefore' => null, 'dayBeforeAt' => '09:00', 'channels' => ['phone', 'desktop']]]);
        $allDay->setPosition(1);
        $this->entityManager->persist($allDay);
    }

    /**
     * @param list<ReminderRule> $rules
     * @param list<string>       $self
     * @param string             $place the event's place to travel to ({@see EventPlace::toTravelTo()}): a place that is
     *                                  only a meeting link, or only says "online", is no place
     */
    public static function match(array $rules, CalendarEvent $event, array $self, string $place): ?ReminderRule
    {
        $best = null;
        foreach ($rules as $rule) {
            if (!self::applies($rule, $event, $self, $place)) {
                continue;
            }
            if (null === $best || $rule->specificity() > $best->specificity()) {
                $best = $rule;
            }
        }

        return $best;
    }

    /** @return list<ReminderRule> */
    public function of(User $user): array
    {
        return $this->rules->findOwnedBy($user);
    }

    /**
     * @param list<string> $self
     */
    private static function applies(ReminderRule $rule, CalendarEvent $event, array $self, string $place): bool
    {
        if (null !== $rule->getCalendar() && !$rule->getCalendar()->getId()->equals($event->getCalendar()->getId())) {
            return false;
        }
        if (null !== $rule->getAllDay() && $rule->getAllDay() !== $event->isAllDay()) {
            return false;
        }
        $others = self::hasOthers($event, $self);
        if (null !== $rule->getWithAttendees() && $rule->getWithAttendees() !== $others) {
            return false;
        }
        if (null !== $rule->getWithConference() && $rule->getWithConference() !== (null !== $event->getConference())) {
            return false;
        }
        if (null !== $rule->getWithLocation() && $rule->getWithLocation() !== ('' !== $place)) {
            return false;
        }

        $invited = null !== $event->getSelfPartstat();

        return match ($rule->getRole()) {
            RuleRole::Any => true,
            RuleRole::Organized => !$invited,
            RuleRole::Invited => $invited,
        };
    }

    /**
     * @param list<string> $self
     */
    public static function hasOthers(CalendarEvent $event, array $self): bool
    {
        foreach ($event->getAttendees() as $attendee) {
            if (!\in_array($attendee['address'], $self, true) && 'room' !== $attendee['kind'] && 'resource' !== $attendee['kind']) {
                return true;
            }
        }
        $organizer = $event->getOrganizer();

        return null !== $organizer && !\in_array($organizer['address'], $self, true);
    }
}
