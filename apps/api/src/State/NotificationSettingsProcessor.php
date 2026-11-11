<?php

declare(strict_types=1);

namespace App\State;

use ApiPlatform\Metadata\Operation;
use ApiPlatform\State\ProcessorInterface;
use App\ApiResource\Input\Notification\UpdateNotificationSettings;
use App\ApiResource\NotificationSettingsResource;
use App\Entity\NotificationPreferences;
use App\Enum\SnoozeChoice;
use App\Enum\TravelMode;
use App\Notification\NotificationEmailAddress;
use App\Notification\NotificationChannelChoice;
use App\Notification\PlanUserNotifications;
use App\Realtime\AfterCommitDispatcher;
use App\Repository\DailyBriefSettingsRepository;
use App\Repository\NotificationPreferencesRepository;
use App\Security\CurrentUser;
use App\Todo\TodoReplanning;
use Doctrine\ORM\EntityManagerInterface;
use Psr\Clock\ClockInterface;

/**
 * @implements ProcessorInterface<UpdateNotificationSettings, NotificationSettingsResource>
 */
final readonly class NotificationSettingsProcessor implements ProcessorInterface
{
    public function __construct(
        private EntityManagerInterface $entityManager,
        private NotificationPreferencesRepository $preferences,
        private CurrentUser $currentUser,
        private AfterCommitDispatcher $afterCommit,
        private NotificationEmailAddress $emailAddresses,
        private DailyBriefSettingsRepository $briefSettings,
        private ClockInterface $clock,
        private TodoReplanning $todoReplanning,
    ) {
    }

    public function process(mixed $data, Operation $operation, array $uriVariables = [], array $context = []): NotificationSettingsResource
    {
        $user = $this->currentUser->get();

        $saved = $this->entityManager->wrapInTransaction(function () use ($user, $data): NotificationPreferences {
            $preferences = $this->preferences->forUser($user);
            $zoneChanged = null !== $data->timeZone && $data->timeZone !== $preferences->getTimeZone();
            if (null !== $data->timeZone) {
                $preferences->setTimeZone($data->timeZone);
            }
            $preferences->setQuietHours(
                $data->quietHoursEnabled ?? $preferences->isQuietHoursEnabled(),
                null === $data->quietDays ? $preferences->getQuietDays() : array_map(intval(...), $data->quietDays),
                $data->quietStart ?? $preferences->getQuietStart(),
                $data->quietEnd ?? $preferences->getQuietEnd(),
            );
            if (null !== $data->focusDuringBusy) {
                $preferences->setFocusDuringBusy($data->focusDuringBusy);
            }
            if (null !== $data->emailAddress) {
                $address = '' === trim($data->emailAddress) ? null : mb_strtolower(trim($data->emailAddress));
                // An address the user does not provably hold waits for the link mailed to it, so notifications cannot
                // be aimed at someone else's inbox.
                $this->emailAddresses->choose($user, $preferences, $address);
            }
            $planningBefore = self::planning($preferences);
            $hoursBefore = [$preferences->getWorkDays(), $preferences->getWorkStart(), $preferences->getWorkEnd()];
            if (null !== $data->workDays || null !== $data->workStart || null !== $data->workEnd) {
                $preferences->setWorkingHours(
                    null === $data->workDays ? $preferences->getWorkDays() : array_map(intval(...), $data->workDays),
                    $data->workStart ?? $preferences->getWorkStart(),
                    $data->workEnd ?? $preferences->getWorkEnd(),
                );
            }
            if (null !== $data->shiftEarlyReminders) {
                $preferences->setShiftEarlyReminders($data->shiftEarlyReminders);
            }
            if (null !== $data->workCalendarsQuiet) {
                $preferences->setWorkCalendarsQuiet($data->workCalendarsQuiet);
            }
            if (null !== $data->holdDuringFocus) {
                $preferences->setHoldDuringFocus($data->holdDuringFocus);
            }
            if (null !== $data->holdMailInMeetings) {
                $preferences->setHoldMailInMeetings($data->holdMailInMeetings);
            }
            if (null !== $data->mailPreviews) {
                $preferences->setMailPreviews($data->mailPreviews);
            }
            if (null !== $data->leaveNow) {
                $preferences->setLeaveNow($data->leaveNow);
            }
            if (null !== $data->travelMode || null !== $data->extraTravelMinutes) {
                $preferences->setTravel(
                    null === $data->travelMode ? $preferences->getTravelMode() : TravelMode::from($data->travelMode),
                    $data->extraTravelMinutes ?? $preferences->getExtraTravelMinutes(),
                );
            }
            if (null !== $data->snoozeChoices) {
                $preferences->setSnoozeChoices(array_map(static fn (mixed $choice): SnoozeChoice => SnoozeChoice::from((string) $choice), $data->snoozeChoices));
            }
            foreach ($data->channelsByKind ?? [] as $kind => $channels) {
                $preferences->setChannelsFor((string) $kind, \is_array($channels) ? NotificationChannelChoice::fromValues(array_values($channels)) : null);
            }
            if ($zoneChanged) {
                // The daily brief comes at its time of day in the new zone.
                $this->briefSettings->findOneFor($user)?->reschedule($preferences->getTimeZone(), $this->clock->now());
            }
            $this->entityManager->flush();
            if ($zoneChanged || $planningBefore !== self::planning($preferences)) {
                // All-day reminders fire at a time of day in the user's zone; planned notifications carry their
                // channels, early reminders move with the working hours, leave-now with the travel settings.
                $this->afterCommit->dispatch(new PlanUserNotifications($user->getId()->toRfc4122()));
            }
            if ($zoneChanged || $hoursBefore !== [$preferences->getWorkDays(), $preferences->getWorkStart(), $preferences->getWorkEnd()]) {
                // Planned todos keep to the working hours, and their deadlines are read in the user's zone.
                $this->todoReplanning->afterCommit($user);
            }

            return $preferences;
        });

        return NotificationSettingsResource::fromEntity($saved, $this->emailAddresses->effective($user, $saved));
    }

    /**
     * What planned notifications depend on, to see whether a change needs a replan.
     *
     * @return list<mixed>
     */
    private static function planning(NotificationPreferences $preferences): array
    {
        return [$preferences->getChannelsByKind(), $preferences->getWorkDays(), $preferences->getWorkStart(), $preferences->getWorkEnd(), $preferences->isShiftEarlyReminders(), $preferences->isLeaveNow(), $preferences->getTravelMode(), $preferences->getExtraTravelMinutes()];
    }
}
