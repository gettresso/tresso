<?php

declare(strict_types=1);

namespace App\Entity;

use App\Repository\CalendarObjectRepository;
use Doctrine\DBAL\Types\Types;
use Doctrine\ORM\Mapping as ORM;
use Symfony\Bridge\Doctrine\Types\UuidType;
use Symfony\Component\Uid\Uuid;

/**
 * One iCalendar object: every VEVENT with one UID (a series with its overrides, or a single event), as the provider
 * stores it in one resource. The iCalendar text is the truth; {@see CalendarEvent} rows are its projection for queries
 * and clients. Keeping the full text means properties Tresso does not model survive an edit.
 *
 * @phpstan-type ConferenceRequest array{provider: string, status: string, reason: ?string, requestedAt: string, nonce: string}
 */
#[ORM\Entity(repositoryClass: CalendarObjectRepository::class)]
#[ORM\UniqueConstraint(columns: ['calendar_id', 'uid'])]
#[ORM\Index(columns: ['calendar_id', 'remote_id'])]
class CalendarObject
{
    #[ORM\Id]
    #[ORM\Column(type: UuidType::NAME)]
    private Uuid $id;

    #[ORM\ManyToOne]
    #[ORM\JoinColumn(nullable: false, onDelete: 'CASCADE')]
    private Calendar $calendar;

    #[ORM\Column(length: 1024)]
    private string $uid;

    /** CalDAV resource href, Google event id or Graph event id; null until the provider has it. */
    #[ORM\Column(length: 2048, nullable: true)]
    private ?string $remoteId = null;

    #[ORM\Column(length: 512, nullable: true)]
    private ?string $etag = null;

    #[ORM\Column(type: Types::TEXT)]
    private string $ical;

    /**
     * A meeting link asked of the calendar's provider that is not on the event (yet): {provider, status (pending or
     * failed), reason (refused, not_supported or unreachable; null while pending), requestedAt (ISO 8601), nonce (the
     * request's own id, which the worker turns into the provider's request id)}. Kept here, not in the iCalendar text,
     * because the provider's version replaces that text. The master row carries it without the nonce.
     *
     * @var ConferenceRequest|null
     */
    #[ORM\Column(type: Types::JSON, nullable: true)]
    private ?array $conferenceRequest = null;

    #[ORM\Column]
    private \DateTimeImmutable $updatedAt;

    public function __construct(Calendar $calendar, string $uid, string $ical)
    {
        $this->id = Uuid::v7();
        $this->calendar = $calendar;
        $this->uid = $uid;
        $this->ical = $ical;
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

    public function getUid(): string
    {
        return $this->uid;
    }

    public function getRemoteId(): ?string
    {
        return $this->remoteId;
    }

    public function getEtag(): ?string
    {
        return $this->etag;
    }

    /** The provider confirmed this version. */
    public function stored(string $remoteId, ?string $etag): void
    {
        $this->remoteId = $remoteId;
        $this->etag = $etag;
    }

    public function getIcal(): string
    {
        return $this->ical;
    }

    public function setIcal(string $ical): void
    {
        $this->ical = $ical;
        $this->updatedAt = new \DateTimeImmutable();
    }

    public function getUpdatedAt(): \DateTimeImmutable
    {
        return $this->updatedAt;
    }

    /** @return ConferenceRequest|null */
    public function getConferenceRequest(): ?array
    {
        return $this->conferenceRequest;
    }

    /** @param ConferenceRequest|null $request */
    public function setConferenceRequest(?array $request): void
    {
        $this->conferenceRequest = $request;
    }
}
