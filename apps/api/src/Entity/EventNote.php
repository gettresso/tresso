<?php

declare(strict_types=1);

namespace App\Entity;

use App\Repository\EventNoteRepository;
use App\Sync\Change\TracksChanges;
use Doctrine\DBAL\Types\Types;
use Doctrine\ORM\Mapping as ORM;
use Symfony\Bridge\Doctrine\Types\UuidType;
use Symfony\Component\Uid\Uuid;

/**
 * The user's private notes on an event or one occurrence of it. Never written to a provider or sent to attendees.
 */
#[ORM\Entity(repositoryClass: EventNoteRepository::class)]
#[ORM\UniqueConstraint(columns: ['event_id', 'occurrence_key'])]
#[ORM\Index(columns: ['user_id', 'change_seq'])]
class EventNote implements TracksChanges
{
    #[ORM\Id]
    #[ORM\Column(type: UuidType::NAME)]
    private Uuid $id;

    #[ORM\Column(type: Types::BIGINT, options: ['default' => 0])]
    private int $changeSeq = 0;

    #[ORM\ManyToOne]
    #[ORM\JoinColumn(nullable: false, onDelete: 'CASCADE')]
    private User $user;

    #[ORM\ManyToOne]
    #[ORM\JoinColumn(nullable: false, onDelete: 'CASCADE')]
    private CalendarEvent $event;

    /** '' for the whole event, else the occurrence. */
    #[ORM\Column(length: 16)]
    private string $occurrenceKey;

    #[ORM\Column(type: Types::TEXT)]
    private string $text = '';

    #[ORM\Column]
    private \DateTimeImmutable $updatedAt;

    public function __construct(CalendarEvent $event, string $occurrenceKey)
    {
        $this->id = Uuid::v7();
        $this->user = $event->getCalendar()->getOwner();
        $this->event = $event;
        $this->occurrenceKey = $occurrenceKey;
        $this->updatedAt = new \DateTimeImmutable();
    }

    public function getId(): Uuid
    {
        return $this->id;
    }

    public function getEvent(): CalendarEvent
    {
        return $this->event;
    }

    public function getOccurrenceKey(): string
    {
        return $this->occurrenceKey;
    }

    public function getText(): string
    {
        return $this->text;
    }

    /**
     * The note follows its occurrence to another row (an override that came or went, the series moved) or to the
     * occurrence's new key.
     */
    public function moveTo(CalendarEvent $event, string $occurrenceKey): void
    {
        $this->event = $event;
        $this->occurrenceKey = $occurrenceKey;
    }

    public function write(string $text): void
    {
        $this->text = $text;
        $this->updatedAt = new \DateTimeImmutable();
    }

    public function getUpdatedAt(): \DateTimeImmutable
    {
        return $this->updatedAt;
    }

    public function getChangeOwner(): User
    {
        return $this->user;
    }

    public static function clientFields(): ?array
    {
        // Where it hangs counts too: clients find a note by its event and occurrence.
        return ['text', 'event', 'occurrenceKey'];
    }

    public static function changeType(): string
    {
        return 'eventNote';
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
