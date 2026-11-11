<?php

declare(strict_types=1);

namespace App\ApiResource\Input\Notification;

use App\Enum\NotificationChannel;
use App\Enum\NotificationKind;
use App\Enum\SnoozeChoice;
use App\Enum\TravelMode;
use Symfony\Component\Validator\Constraints as Assert;
use Symfony\Component\Validator\Context\ExecutionContextInterface;

/** Partial update (JSON merge patch). Omitted or null fields stay as they are. */
final class UpdateNotificationSettings
{
    #[Assert\Timezone]
    public ?string $timeZone = null;

    public ?bool $quietHoursEnabled = null;

    /** @var list<int>|null ISO days (1 = Monday) */
    #[Assert\All([new Assert\Range(min: 1, max: 7)])]
    public ?array $quietDays = null;

    #[Assert\Regex('/^([01]\d|2[0-3]):[0-5]\d$/', message: 'Use HH:MM.')]
    public ?string $quietStart = null;

    #[Assert\Regex('/^([01]\d|2[0-3]):[0-5]\d$/', message: 'Use HH:MM.')]
    public ?string $quietEnd = null;

    public ?bool $focusDuringBusy = null;

    /**
     * Where email notifications go; an empty string goes back to the sign-in address. The sign-in address and a Google
     * or Microsoft account's address count at once; any other address waits for the confirmation link mailed to it.
     */
    #[Assert\AtLeastOneOf([new Assert\Blank(), new Assert\Email(mode: Assert\Email::VALIDATION_MODE_STRICT)])]
    #[Assert\Length(max: 320)]
    public ?string $emailAddress = null;

    /** @var list<int>|null ISO days (1 = Monday) */
    #[Assert\All([new Assert\Range(min: 1, max: 7)])]
    public ?array $workDays = null;

    #[Assert\Regex('/^([01]\d|2[0-3]):[0-5]\d$/', message: 'Use HH:MM.')]
    public ?string $workStart = null;

    #[Assert\Regex('/^([01]\d|2[0-3]):[0-5]\d$/', message: 'Use HH:MM.')]
    public ?string $workEnd = null;

    public ?bool $shiftEarlyReminders = null;

    public ?bool $workCalendarsQuiet = null;

    public ?bool $holdDuringFocus = null;

    public ?bool $holdMailInMeetings = null;

    /** Mail notifications show the sender, subject and the start of the text; false: only the account. */
    public ?bool $mailPreviews = null;

    public ?bool $leaveNow = null;

    #[Assert\Choice(callback: [TravelMode::class, 'values'])]
    public ?string $travelMode = null;

    #[Assert\Range(min: 0, max: 60)]
    public ?int $extraTravelMinutes = null;

    /** @var list<string>|null */
    #[Assert\Count(min: 1, max: 6)]
    #[Assert\All([new Assert\Choice(callback: [SnoozeChoice::class, 'values'])])]
    public ?array $snoozeChoices = null;

    /**
     * Channels per kind of notification (NotificationKind::withChosenChannels()): a list of channel names (empty: not
     * sent), or null to go back to the default. Kinds left out stay as they are.
     *
     * @var array<mixed>|null as sent; the callback below checks the shape
     */
    public ?array $channelsByKind = null;

    #[Assert\Callback]
    public function validateChannels(ExecutionContextInterface $context): void
    {
        foreach ($this->channelsByKind ?? [] as $kind => $channels) {
            if (!\is_string($kind) || !\in_array($kind, NotificationKind::withChosenChannels(), true)) {
                $context->buildViolation(\sprintf('Channels can be chosen for %s.', implode(', ', NotificationKind::withChosenChannels())))->atPath('channelsByKind')->addViolation();

                continue;
            }
            if (null === $channels) {
                continue;
            }
            if (!\is_array($channels) || !array_is_list($channels)) {
                $context->buildViolation('Give a list of channels.')->atPath('channelsByKind['.$kind.']')->addViolation();

                continue;
            }
            foreach ($channels as $channel) {
                if (!\is_string($channel) || null === NotificationChannel::tryFrom($channel)) {
                    $context->buildViolation('Channels are phone, desktop and email.')->atPath('channelsByKind['.$kind.']')->addViolation();
                }
            }
        }
    }
}
