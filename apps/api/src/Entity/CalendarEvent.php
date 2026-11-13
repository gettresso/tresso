<?php

declare(strict_types=1);

namespace App\Entity;

use App\Calendar\ICalendar\EventData;
use App\Calendar\ICalendar\EventTime;
use App\Enum\EventStatus;
use App\Enum\EventVisibility;
use App\Enum\ParticipationStatus;
use App\Enum\Transparency;
use App\Repository\CalendarEventRepository;
use App\Sync\Change\TracksChanges;
use Doctrine\DBAL\Types\Types;
use Doctrine\ORM\Mapping as ORM;
use Symfony\Bridge\Doctrine\Types\UuidType;
use Symfony\Component\Uid\Uuid;

/**
 * One VEVENT of a {@see CalendarObject}: a single event, the master of a series, or the override of one occurrence.
 * Rows are written only by the projection of their resource, so they always agree with its iCalendar text.
 *
 * @phpstan-import-type Address from EventData
 * @phpstan-import-type Attendee from EventData
 * @phpstan-import-type Reminder from EventData
 * @phpstan-import-type Conference from EventData
 *
 * @phpstan-type PublicConferenceRequest array{provider: string, status: string, reason: ?string, requestedAt: string}
 */
#[ORM\Entity(repositoryClass: CalendarEventRepository::class)]
#[ORM\UniqueConstraint(columns: ['calendar_id', 'uid', 'recurrence_key'])]
#[ORM\Index(columns: ['calendar_id', 'starts_at'])]
#[ORM\Index(columns: ['calendar_id', 'series_ends_at'])]
#[ORM\Index(columns: ['calendar_id', 'change_seq'])]
#[ORM\Index(columns: ['message_id'])]
class CalendarEvent implements TracksChanges
{
    #[ORM\Id]
    #[ORM\Column(type: UuidType::NAME)]
    private Uuid $id;

    #[ORM\Column(type: Types::BIGINT, options: ['default' => 0])]
    private int $changeSeq = 0;

    #[ORM\ManyToOne]
    #[ORM\JoinColumn(nullable: false, onDelete: 'CASCADE')]
    private Calendar $calendar;

    #[ORM\ManyToOne]
    #[ORM\JoinColumn(nullable: false, onDelete: 'CASCADE')]
    private CalendarObject $object;

    #[ORM\Column(length: 1024)]
    private string $uid;

    /** '' for a master or single event, else the overridden occurrence (see RecurrenceKey). */
    #[ORM\Column(length: 16)]
    private string $recurrenceKey;

    #[ORM\Column]
    private int $sequence = 0;

    #[ORM\Column(length: 16, enumType: EventStatus::class)]
    private EventStatus $status = EventStatus::Confirmed;

    #[ORM\Column(type: Types::TEXT)]
    private string $summary = '';

    #[ORM\Column(type: Types::TEXT)]
    private string $description = '';

    #[ORM\Column(type: Types::TEXT)]
    private string $location = '';

    #[ORM\Column(length: 2048, nullable: true)]
    private ?string $url = null;

    #[ORM\Column(length: 8, enumType: Transparency::class)]
    private Transparency $transparency = Transparency::Busy;

    #[ORM\Column(length: 16, enumType: EventVisibility::class)]
    private EventVisibility $visibility = EventVisibility::Public;

    #[ORM\Column]
    private bool $allDay = false;

    #[ORM\Column(length: 19)]
    private string $startValue = '';

    #[ORM\Column(length: 64, nullable: true)]
    private ?string $startTimeZone = null;

    #[ORM\Column(length: 19)]
    private string $endValue = '';

    #[ORM\Column(length: 64, nullable: true)]
    private ?string $endTimeZone = null;

    /** First occurrence in UTC, for range queries; dates and floating times as if in UTC. */
    #[ORM\Column]
    private \DateTimeImmutable $startsAt;

    #[ORM\Column]
    private \DateTimeImmutable $endsAt;

    /** End of the last occurrence in UTC; null for a series without end. */
    #[ORM\Column(nullable: true)]
    private ?\DateTimeImmutable $seriesEndsAt = null;

    #[ORM\Column(type: Types::TEXT, nullable: true)]
    private ?string $rrule = null;

    /** @var list<string> */
    #[ORM\Column(type: Types::JSON)]
    private array $rdates = [];

    /** @var list<string> */
    #[ORM\Column(type: Types::JSON)]
    private array $exdates = [];

    /** @var Address|null */
    #[ORM\Column(type: Types::JSON, nullable: true)]
    private ?array $organizer = null;

    /** @var list<Attendee> */
    #[ORM\Column(type: Types::JSON)]
    private array $attendees = [];

    /** The owner's own response when they are invited; null when they organize or nobody is invited. */
    #[ORM\Column(length: 16, nullable: true, enumType: ParticipationStatus::class)]
    private ?ParticipationStatus $selfPartstat = null;

    /** @var list<Reminder> */
    #[ORM\Column(type: Types::JSON)]
    private array $reminders = [];

    /** @var Conference|null */
    #[ORM\Column(type: Types::JSON, nullable: true)]
    private ?array $conference = null;

    /**
     * The meeting link asked for and not on the event (yet), on the master row only; null on overrides, when nothing
     * was asked for, and once the event has a conference. The object's request without its nonce.
     *
     * @var PublicConferenceRequest|null
     */
    #[ORM\Column(type: Types::JSON, nullable: true)]
    private ?array $conferenceRequest = null;

    #[ORM\Column(nullable: true)]
    private ?int $travelMinutes = null;

    /** No reminders of its own: the user's default rules apply. */
    #[ORM\Column(options: ['default' => true])]
    private bool $defaultReminders = true;

    /** A high priority: reminders reach the user also in quiet and outside working hours. */
    #[ORM\Column(options: ['default' => false])]
    private bool $important = false;

    /** An override with RANGE=THISANDFUTURE: it changes every later occurrence of the series too. */
    #[ORM\Column(options: ['default' => false])]
    private bool $thisAndFuture = false;

    /** The invitation this event came from. */
    #[ORM\ManyToOne]
    #[ORM\JoinColumn(onDelete: 'SET NULL')]
    private ?Message $message = null;

    /** Why the last change did not reach the provider, for the user. */
    #[ORM\Column(length: 500, nullable: true)]
    private ?string $syncError = null;

    #[ORM\Column]
    private \DateTimeImmutable $createdAt;

    #[ORM\Column]
    private \DateTimeImmutable $updatedAt;

    public function __construct(CalendarObject $object, EventData $data)
    {
        $this->id = Uuid::v7();
        $this->object = $object;
        $this->calendar = $object->getCalendar();
        $this->uid = $data->uid;
        $this->recurrenceKey = $data->recurrenceKey;
        $this->createdAt = new \DateTimeImmutable();
        $this->startsAt = $data->startsAt;
        $this->endsAt = $data->endsAt;
        $this->updatedAt = $this->createdAt;
        $this->apply($data);
    }

    /**
     * Takes over the parsed VEVENT. Only fields that really differ are written, so an unchanged event is not a change
     * for clients.
     */
    public function apply(EventData $data): void
    {
        if ($data->uid !== $this->uid || $data->recurrenceKey !== $this->recurrenceKey) {
            throw new \LogicException('An event row only takes data of its own UID and recurrence.');
        }
        $this->sequence = $data->sequence;
        $this->status = $data->status;
        $this->summary = $data->summary;
        $this->description = $data->description;
        $this->location = $data->location;
        $this->url = $data->url;
        $this->transparency = $data->transparency;
        $this->visibility = $data->visibility;
        $this->allDay = $data->isAllDay();
        $this->startValue = $data->start->value;
        $this->startTimeZone = $data->start->timeZone;
        $this->endValue = $data->end->value;
        $this->endTimeZone = $data->end->timeZone;
        if ($this->startsAt != $data->startsAt) {
            $this->startsAt = $data->startsAt;
        }
        if ($this->endsAt != $data->endsAt) {
            $this->endsAt = $data->endsAt;
        }
        if ($this->seriesEndsAt != $data->seriesEndsAt) {
            $this->seriesEndsAt = $data->seriesEndsAt;
        }
        $this->rrule = $data->rrule;
        $this->rdates = $data->rdates;
        $this->exdates = $data->exdates;
        $this->organizer = $data->organizer;
        $this->attendees = $data->attendees;
        $this->selfPartstat = $data->selfPartstat;
        $this->reminders = $data->reminders;
        $this->conference = $data->conference;
        $this->travelMinutes = $data->travelMinutes;
        $this->defaultReminders = $data->defaultReminders;
        $this->important = $data->important;
        $this->thisAndFuture = $data->thisAndFuture;
        $this->updatedAt = new \DateTimeImmutable();
    }

    public function getId(): Uuid
    {
        return $this->id;
    }

    public function getCalendar(): Calendar
    {
        return $this->calendar;
    }

    public function getObject(): CalendarObject
    {
        return $this->object;
    }

    public function getUid(): string
    {
        return $this->uid;
    }

    public function getRecurrenceKey(): string
    {
        return $this->recurrenceKey;
    }

    public function isOverride(): bool
    {
        return '' !== $this->recurrenceKey;
    }

    public function isRecurring(): bool
    {
        return null !== $this->rrule || [] !== $this->rdates;
    }

    public function getSequence(): int
    {
        return $this->sequence;
    }

    public function getStatus(): EventStatus
    {
        return $this->status;
    }

    public function getSummary(): string
    {
        return $this->summary;
    }

    public function getDescription(): string
    {
        return $this->description;
    }

    public function getLocation(): string
    {
        return $this->location;
    }

    public function getUrl(): ?string
    {
        return $this->url;
    }

    public function getTransparency(): Transparency
    {
        return $this->transparency;
    }

    public function getVisibility(): EventVisibility
    {
        return $this->visibility;
    }

    public function isAllDay(): bool
    {
        return $this->allDay;
    }

    public function getStart(): EventTime
    {
        return EventTime::fromArray($this->allDay ? ['date' => $this->startValue] : ['dateTime' => $this->startValue, 'timeZone' => $this->startTimeZone]);
    }

    public function getEnd(): EventTime
    {
        return EventTime::fromArray($this->allDay ? ['date' => $this->endValue] : ['dateTime' => $this->endValue, 'timeZone' => $this->endTimeZone]);
    }

    public function getStartsAt(): \DateTimeImmutable
    {
        return $this->startsAt;
    }

    public function getEndsAt(): \DateTimeImmutable
    {
        return $this->endsAt;
    }

    public function getSeriesEndsAt(): ?\DateTimeImmutable
    {
        return $this->seriesEndsAt;
    }

    public function getRrule(): ?string
    {
        return $this->rrule;
    }

    /** @return list<string> */
    public function getRdates(): array
    {
        return $this->rdates;
    }

    /** @return list<string> */
    public function getExdates(): array
    {
        return $this->exdates;
    }

    /** @return Address|null */
    public function getOrganizer(): ?array
    {
        return $this->organizer;
    }

    /** @return list<Attendee> */
    public function getAttendees(): array
    {
        return $this->attendees;
    }

    public function getSelfPartstat(): ?ParticipationStatus
    {
        return $this->selfPartstat;
    }

    /** @return list<Reminder> */
    public function getReminders(): array
    {
        return $this->reminders;
    }

    /** @return Conference|null */
    public function getConference(): ?array
    {
        return $this->conference;
    }

    /**
     * Whether Tresso can take the meeting off the event (false for a Teams meeting Microsoft made on its calendar's
     * event), as `removable` in the conference clients get. Set by the projection after the event's data.
     */
    public function markConferenceRemovable(bool $removable): void
    {
        if (null !== $this->conference) {
            $this->conference = [...$this->conference, 'removable' => $removable];
        }
    }

    /** @return PublicConferenceRequest|null */
    public function getConferenceRequest(): ?array
    {
        return $this->conferenceRequest;
    }

    /**
     * Assigned only when it differs, so a projection that changes nothing is no change for clients.
     *
     * @param PublicConferenceRequest|null $request
     */
    public function setConferenceRequest(?array $request): void
    {
        if ($request !== $this->conferenceRequest) {
            $this->conferenceRequest = $request;
        }
    }

    public function isImportant(): bool
    {
        return $this->important;
    }

    public function changesTheFuture(): bool
    {
        return $this->thisAndFuture;
    }

    public function getTravelMinutes(): ?int
    {
        return $this->travelMinutes;
    }

    public function usesDefaultReminders(): bool
    {
        return $this->defaultReminders;
    }

    public function getMessage(): ?Message
    {
        return $this->message;
    }

    public function setMessage(?Message $message): void
    {
        $this->message = $message;
    }

    public function getSyncError(): ?string
    {
        return $this->syncError;
    }

    public function setSyncError(?string $syncError): void
    {
        $this->syncError = null === $syncError ? null : mb_substr($syncError, 0, 500);
    }

    public function getCreatedAt(): \DateTimeImmutable
    {
        return $this->createdAt;
    }

    public function getUpdatedAt(): \DateTimeImmutable
    {
        return $this->updatedAt;
    }

    public function getChangeOwner(): User
    {
        return $this->calendar->getOwner();
    }

    public static function clientFields(): ?array
    {
        return [
            'sequence', 'status', 'summary', 'description', 'location', 'url', 'transparency', 'visibility', 'allDay',
            'startValue', 'startTimeZone', 'endValue', 'endTimeZone', 'rrule', 'rdates', 'exdates', 'organizer',
            'attendees', 'selfPartstat', 'reminders', 'conference', 'conferenceRequest', 'message', 'syncError', 'travelMinutes', 'defaultReminders', 'important', 'thisAndFuture',
        ];
    }

    public static function changeType(): string
    {
        return 'calendarEvent';
    }

    public function getChangeSeq(): int
    {
        return $this->changeSeq;
    }

    public function setChangeSeq(int $changeSeq): void
    {
        $this->changeSeq = $changeSeq;
    }
}
