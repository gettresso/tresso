<?php

declare(strict_types=1);

namespace App\ApiResource;

use ApiPlatform\Metadata\ApiResource;
use ApiPlatform\Metadata\Get;
use ApiPlatform\Metadata\Patch;
use App\ApiResource\Input\Notification\UpdateNotificationSettings;
use App\Entity\NotificationPreferences;
use App\Enum\SnoozeChoice;
use App\Security\Scope;
use App\State\NotificationSettingsProcessor;
use App\State\NotificationSettingsProvider;

/**
 * Quiet hours, working hours, focus, travel, snooze choices, the channels per kind of notification and where email
 * notifications go: `effectiveEmailAddress` is where they go now. An address the user does not provably hold waits as
 * `pendingEmailAddress` until the link mailed to it is used (`pendingEmailAddressSentAt`: when the last one went out,
 * null when none did); choosing it again sends the link again.
 */
#[ApiResource(
    shortName: 'NotificationSettings',
    routePrefix: '/api/v1',
    normalizationContext: ['skip_null_values' => false],
    operations: [
        new Get(uriTemplate: '/notification-settings', uriVariables: [], security: "is_granted('".Scope::ROLE_SETTINGS_READ."')", provider: NotificationSettingsProvider::class),
        new Patch(uriTemplate: '/notification-settings', uriVariables: [], security: "is_granted('".Scope::ROLE_SETTINGS_WRITE."')", input: UpdateNotificationSettings::class, provider: NotificationSettingsProvider::class, processor: NotificationSettingsProcessor::class),
    ],
)]
final readonly class NotificationSettingsResource
{
    /**
     * @param list<int>    $quietDays
     * @param object       $channelsByKind the user's choices, kind to list of channels; kinds missing here use their
     *                                     default (an object, so an empty one is {} in JSON)
     * @param list<int>    $workDays
     * @param list<string> $snoozeChoices
     */
    public function __construct(
        public string $timeZone,
        public bool $quietHoursEnabled,
        public array $quietDays,
        public string $quietStart,
        public string $quietEnd,
        public bool $focusDuringBusy,
        public ?string $emailAddress,
        public string $effectiveEmailAddress,
        public ?string $pendingEmailAddress,
        public ?string $pendingEmailAddressSentAt,
        public object $channelsByKind,
        public array $workDays,
        public string $workStart,
        public string $workEnd,
        public bool $shiftEarlyReminders,
        public bool $workCalendarsQuiet,
        public bool $holdDuringFocus,
        public bool $holdMailInMeetings,
        public bool $mailPreviews,
        public bool $leaveNow,
        public string $travelMode,
        public int $extraTravelMinutes,
        public array $snoozeChoices,
    ) {
    }

    /** @param string $effectiveEmailAddress where notification mail goes now (NotificationEmailAddress::effective()) */
    public static function fromEntity(NotificationPreferences $preferences, string $effectiveEmailAddress): self
    {
        return new self(
            $preferences->getTimeZone(),
            $preferences->isQuietHoursEnabled(),
            $preferences->getQuietDays(),
            $preferences->getQuietStart(),
            $preferences->getQuietEnd(),
            $preferences->isFocusDuringBusy(),
            $preferences->getEmailAddress(),
            $effectiveEmailAddress,
            $preferences->getPendingEmailAddress(),
            $preferences->getPendingEmailSentAt()?->format(\DATE_ATOM),
            (object) $preferences->getChannelsByKind(),
            $preferences->getWorkDays(),
            $preferences->getWorkStart(),
            $preferences->getWorkEnd(),
            $preferences->isShiftEarlyReminders(),
            $preferences->isWorkCalendarsQuiet(),
            $preferences->isHoldDuringFocus(),
            $preferences->isHoldMailInMeetings(),
            $preferences->isMailPreviews(),
            $preferences->isLeaveNow(),
            $preferences->getTravelMode()->value,
            $preferences->getExtraTravelMinutes(),
            array_map(static fn (SnoozeChoice $choice): string => $choice->value, $preferences->getSnoozeChoices()),
        );
    }
}
