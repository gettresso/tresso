<?php

declare(strict_types=1);

namespace App\Entity;

use App\Enum\NotificationAddressProof;
use App\Enum\SnoozeChoice;
use App\Enum\TravelMode;
use App\Notification\NotificationChannelChoice;
use App\Repository\NotificationPreferencesRepository;
use Doctrine\DBAL\Types\Types;
use Doctrine\ORM\Mapping as ORM;

/**
 * When and how the user wants to be disturbed: quiet hours, focus during busy events, the channels per kind of
 * notification, and where email notifications go. Also how far ahead their notifications are planned.
 */
#[ORM\Entity(repositoryClass: NotificationPreferencesRepository::class)]
#[ORM\Index(columns: ['planned_until'])]
class NotificationPreferences
{
    #[ORM\Id]
    #[ORM\OneToOne]
    #[ORM\JoinColumn(nullable: false, onDelete: 'CASCADE')]
    private User $user;

    public const string DEFAULT_TIME_ZONE = 'UTC';

    /** IANA zone the quiet hours and all-day reminders are read in. */
    #[ORM\Column(length: 64)]
    private string $timeZone = self::DEFAULT_TIME_ZONE;

    #[ORM\Column]
    private bool $quietHoursEnabled = false;

    /** @var list<int> ISO days (1 = Monday) the quiet hours start on */
    #[ORM\Column(type: Types::JSON)]
    private array $quietDays = [1, 2, 3, 4, 5, 6, 7];

    /** HH:MM; quiet hours past midnight end the next day. */
    #[ORM\Column(length: 5)]
    private string $quietStart = '22:00';

    #[ORM\Column(length: 5)]
    private string $quietEnd = '07:00';

    /** While a busy event runs, only the user's own meetings and leave-now alerts break through. */
    #[ORM\Column]
    private bool $focusDuringBusy = true;

    /** @var list<int> ISO days (1 = Monday) with working hours */
    #[ORM\Column(type: Types::JSON)]
    private array $workDays = [1, 2, 3, 4, 5];

    /** HH:MM, in the user's zone. */
    #[ORM\Column(length: 5)]
    private string $workStart = '09:00';

    #[ORM\Column(length: 5)]
    private string $workEnd = '17:30';

    /** A reminder that would come before the working day, for an event before it starts, comes at the end of the working day before. */
    #[ORM\Column]
    private bool $shiftEarlyReminders = true;

    /** Notifications of work calendars wait for working hours, except leave-now and important events. */
    #[ORM\Column]
    private bool $workCalendarsQuiet = true;

    /** During a focus block, notifications wait until it ends; meetings with others and leave-now come through. */
    #[ORM\Column]
    private bool $holdDuringFocus = true;

    /** Mail notifications wait while the user is in a meeting (read by the mail notifications). */
    #[ORM\Column]
    private bool $holdMailInMeetings = true;

    /**
     * Mail notifications show the sender, subject and the start of the text; without, only "New mail from {account}"
     * (Expo pushes pass through Expo, Apple and Google unencrypted).
     */
    #[ORM\Column(options: ['default' => true])]
    private bool $mailPreviews = true;

    /** Leave-now reminders for events with a place. */
    #[ORM\Column]
    private bool $leaveNow = true;

    #[ORM\Column(length: 16, enumType: TravelMode::class)]
    private TravelMode $travelMode = TravelMode::Car;

    /** Minutes added to the travel time. */
    #[ORM\Column]
    private int $extraTravelMinutes = 5;

    /** @var list<string> the snooze choices a reminder offers, in order (SnoozeChoice values) */
    #[ORM\Column(type: Types::JSON)]
    private array $snoozeChoices = ['minutes_5', 'before_start', 'start', 'meeting_end'];

    /**
     * The user's channels per kind of notification ("leave_now", "brief", or a kind of another feature), as channel
     * names; a kind missing here uses the default its feature gives.
     *
     * @var array<string, list<string>>
     */
    #[ORM\Column(type: Types::JSON)]
    private array $channelsByKind = [];

    /**
     * Where email notifications go; the sign-in address when null. See App\Notification\NotificationEmailAddress for
     * when it counts.
     */
    #[ORM\Column(length: 320, nullable: true)]
    private ?string $emailAddress = null;

    /**
     * How {@see $emailAddress} was shown to be the user's when it was chosen; null for an address chosen before this
     * was recorded and never proven.
     */
    #[ORM\Column(length: 16, nullable: true, enumType: NotificationAddressProof::class)]
    private ?NotificationAddressProof $emailAddressProof = null;

    /** When the user confirmed {@see $emailAddress} with the link mailed to it. */
    #[ORM\Column(nullable: true)]
    private ?\DateTimeImmutable $emailAddressConfirmedAt = null;

    /** An address the user chose that waits for its confirmation link; notifications keep going where they went. */
    #[ORM\Column(length: 320, nullable: true)]
    private ?string $pendingEmailAddress = null;

    /** When the last confirmation link for {@see $pendingEmailAddress} was mailed; null when none went out yet. */
    #[ORM\Column(nullable: true)]
    private ?\DateTimeImmutable $pendingEmailSentAt = null;

    /** Notifications are planned up to here; the sweep extends it. */
    #[ORM\Column(nullable: true)]
    private ?\DateTimeImmutable $plannedUntil = null;

    /** Planning failed for this user: the sweep tries again from here. */
    #[ORM\Column(nullable: true)]
    private ?\DateTimeImmutable $planRetryAt = null;

    public function __construct(User $user)
    {
        $this->user = $user;
    }

    public function getUser(): User
    {
        return $this->user;
    }

    public function getTimeZone(): string
    {
        return $this->timeZone;
    }

    public function setTimeZone(string $timeZone): void
    {
        $this->timeZone = $timeZone;
    }

    public function isQuietHoursEnabled(): bool
    {
        return $this->quietHoursEnabled;
    }

    /** @return list<int> */
    public function getQuietDays(): array
    {
        return $this->quietDays;
    }

    public function getQuietStart(): string
    {
        return $this->quietStart;
    }

    public function getQuietEnd(): string
    {
        return $this->quietEnd;
    }

    /**
     * @param list<int> $days
     */
    public function setQuietHours(bool $enabled, array $days, string $start, string $end): void
    {
        $this->quietHoursEnabled = $enabled;
        $this->quietDays = array_values(array_unique($days));
        sort($this->quietDays);
        $this->quietStart = $start;
        $this->quietEnd = $end;
    }

    public function isFocusDuringBusy(): bool
    {
        return $this->focusDuringBusy;
    }

    public function setFocusDuringBusy(bool $focusDuringBusy): void
    {
        $this->focusDuringBusy = $focusDuringBusy;
    }

    public function channelsFor(string $kind, NotificationChannelChoice $default): NotificationChannelChoice
    {
        return \array_key_exists($kind, $this->channelsByKind) ? NotificationChannelChoice::fromValues($this->channelsByKind[$kind]) : $default;
    }

    /**
     * @return array<string, list<string>>
     */
    public function getChannelsByKind(): array
    {
        return $this->channelsByKind;
    }

    /**
     * Sets the channels of one kind; null goes back to the feature's default.
     */
    public function setChannelsFor(string $kind, ?NotificationChannelChoice $choice): void
    {
        if (null === $choice) {
            unset($this->channelsByKind[$kind]);

            return;
        }
        $this->channelsByKind[$kind] = $choice->values();
    }

    /**
     * @return list<int>
     */
    public function getWorkDays(): array
    {
        return $this->workDays;
    }

    public function getWorkStart(): string
    {
        return $this->workStart;
    }

    public function getWorkEnd(): string
    {
        return $this->workEnd;
    }

    /**
     * @param list<int> $days
     */
    public function setWorkingHours(array $days, string $start, string $end): void
    {
        $days = array_values(array_unique($days));
        sort($days);
        $this->workDays = $days;
        $this->workStart = $start;
        $this->workEnd = $end;
    }

    public function isShiftEarlyReminders(): bool
    {
        return $this->shiftEarlyReminders;
    }

    public function setShiftEarlyReminders(bool $shift): void
    {
        $this->shiftEarlyReminders = $shift;
    }

    public function isWorkCalendarsQuiet(): bool
    {
        return $this->workCalendarsQuiet;
    }

    public function setWorkCalendarsQuiet(bool $quiet): void
    {
        $this->workCalendarsQuiet = $quiet;
    }

    public function isHoldDuringFocus(): bool
    {
        return $this->holdDuringFocus;
    }

    public function setHoldDuringFocus(bool $hold): void
    {
        $this->holdDuringFocus = $hold;
    }

    public function isHoldMailInMeetings(): bool
    {
        return $this->holdMailInMeetings;
    }

    public function setHoldMailInMeetings(bool $hold): void
    {
        $this->holdMailInMeetings = $hold;
    }

    public function isMailPreviews(): bool
    {
        return $this->mailPreviews;
    }

    public function setMailPreviews(bool $previews): void
    {
        $this->mailPreviews = $previews;
    }

    public function isLeaveNow(): bool
    {
        return $this->leaveNow;
    }

    public function setLeaveNow(bool $leaveNow): void
    {
        $this->leaveNow = $leaveNow;
    }

    public function getTravelMode(): TravelMode
    {
        return $this->travelMode;
    }

    public function setTravel(TravelMode $mode, int $extraMinutes): void
    {
        $this->travelMode = $mode;
        $this->extraTravelMinutes = $extraMinutes;
    }

    public function getExtraTravelMinutes(): int
    {
        return $this->extraTravelMinutes;
    }

    /**
     * @return list<SnoozeChoice>
     */
    public function getSnoozeChoices(): array
    {
        return array_values(array_filter(array_map(SnoozeChoice::tryFrom(...), $this->snoozeChoices)));
    }

    /**
     * @param list<SnoozeChoice> $choices
     */
    public function setSnoozeChoices(array $choices): void
    {
        $this->snoozeChoices = array_values(array_unique(array_map(static fn (SnoozeChoice $choice): string => $choice->value, $choices)));
    }

    public function getEmailAddress(): ?string
    {
        return $this->emailAddress;
    }

    /**
     * Notifications go here from now on (null: the sign-in address), shown to be the user's as $proof says;
     * $confirmedAt is when its link was used. Any pending address is dropped.
     */
    public function setEmailAddress(?string $emailAddress, ?NotificationAddressProof $proof = null, ?\DateTimeImmutable $confirmedAt = null): void
    {
        $this->emailAddress = null === $emailAddress ? null : mb_strtolower($emailAddress);
        $this->emailAddressProof = null === $emailAddress ? null : $proof;
        $this->emailAddressConfirmedAt = null === $emailAddress ? null : $confirmedAt;
        $this->pendingEmailAddress = null;
        $this->pendingEmailSentAt = null;
    }

    public function getEmailAddressProof(): ?NotificationAddressProof
    {
        return $this->emailAddressProof;
    }

    public function getEmailAddressConfirmedAt(): ?\DateTimeImmutable
    {
        return $this->emailAddressConfirmedAt;
    }

    public function getPendingEmailAddress(): ?string
    {
        return $this->pendingEmailAddress;
    }

    public function getPendingEmailSentAt(): ?\DateTimeImmutable
    {
        return $this->pendingEmailSentAt;
    }

    /** The user chose an address that needs its confirmation link; where notifications go stays as it is. */
    public function choosePendingEmailAddress(string $address): void
    {
        $address = mb_strtolower($address);
        if ($address !== $this->pendingEmailAddress) {
            $this->pendingEmailAddress = $address;
            $this->pendingEmailSentAt = null;
        }
    }

    /**
     * An address that was never shown to be the user's (chosen before that was recorded): it waits for its link from
     * now on, and notifications go to the sign-in address until then.
     */
    public function moveEmailAddressToPending(): void
    {
        if (null === $this->emailAddress) {
            return;
        }
        $this->pendingEmailAddress = $this->emailAddress;
        $this->pendingEmailSentAt = null;
        $this->emailAddress = null;
        $this->emailAddressProof = null;
        $this->emailAddressConfirmedAt = null;
    }

    public function markConfirmationSent(\DateTimeImmutable $at): void
    {
        $this->pendingEmailSentAt = $at;
    }

    public function getPlannedUntil(): ?\DateTimeImmutable
    {
        return $this->plannedUntil;
    }

    public function setPlannedUntil(?\DateTimeImmutable $plannedUntil): void
    {
        $this->plannedUntil = $plannedUntil;
        $this->planRetryAt = null;
    }

    public function getPlanRetryAt(): ?\DateTimeImmutable
    {
        return $this->planRetryAt;
    }

    public function retryPlanningAt(\DateTimeImmutable $at): void
    {
        $this->planRetryAt = $at;
    }
}
