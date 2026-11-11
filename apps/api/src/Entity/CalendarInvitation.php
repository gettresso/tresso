<?php

declare(strict_types=1);

namespace App\Entity;

use App\Enum\ItipMethod;
use App\Repository\CalendarInvitationRepository;
use Doctrine\DBAL\Types\Types;
use Doctrine\ORM\Mapping as ORM;
use Symfony\Bridge\Doctrine\Types\UuidType;
use Symfony\Component\Uid\Uuid;

/**
 * A calendar object that came by mail (iTIP over iMIP, RFC 6047): an invitation, an update, a cancellation or a
 * reply. Recorded at ingest and applied to the user's calendars afterwards.
 */
#[ORM\Entity(repositoryClass: CalendarInvitationRepository::class)]
#[ORM\Index(columns: ['message_id'])]
#[ORM\Index(columns: ['uid'])]
class CalendarInvitation
{
    #[ORM\Id]
    #[ORM\Column(type: UuidType::NAME)]
    private Uuid $id;

    #[ORM\ManyToOne]
    #[ORM\JoinColumn(nullable: false, onDelete: 'CASCADE')]
    private Message $message;

    #[ORM\Column(length: 16, enumType: ItipMethod::class)]
    private ItipMethod $method;

    #[ORM\Column(length: 1024)]
    private string $uid;

    #[ORM\Column]
    private int $sequence;

    /** '' when the object is about the whole event, else the occurrence. */
    #[ORM\Column(length: 16)]
    private string $recurrenceKey;

    #[ORM\Column(type: Types::TEXT)]
    private string $ical;

    #[ORM\Column(nullable: true)]
    private ?\DateTimeImmutable $appliedAt = null;

    /** Not applied by itself because the provider did not confirm its sender: it waits for the user. */
    #[ORM\Column(options: ['default' => false])]
    private bool $waitsForUser = false;

    #[ORM\Column]
    private \DateTimeImmutable $createdAt;

    public function __construct(Message $message, ItipMethod $method, string $uid, int $sequence, string $recurrenceKey, string $ical)
    {
        $this->id = Uuid::v7();
        $this->message = $message;
        $this->method = $method;
        $this->uid = $uid;
        $this->sequence = $sequence;
        $this->recurrenceKey = $recurrenceKey;
        $this->ical = $ical;
        $this->createdAt = new \DateTimeImmutable();
    }

    public function getId(): Uuid
    {
        return $this->id;
    }

    public function getMessage(): Message
    {
        return $this->message;
    }

    public function getMethod(): ItipMethod
    {
        return $this->method;
    }

    public function getUid(): string
    {
        return $this->uid;
    }

    public function getSequence(): int
    {
        return $this->sequence;
    }

    public function getRecurrenceKey(): string
    {
        return $this->recurrenceKey;
    }

    public function getIcal(): string
    {
        return $this->ical;
    }

    public function getAppliedAt(): ?\DateTimeImmutable
    {
        return $this->appliedAt;
    }

    public function markApplied(\DateTimeImmutable $at): void
    {
        $this->appliedAt = $at;
        $this->waitsForUser = false;
    }

    public function waitForUser(): void
    {
        $this->waitsForUser = true;
    }

    public function waitsForUser(): bool
    {
        return $this->waitsForUser;
    }

    public function getCreatedAt(): \DateTimeImmutable
    {
        return $this->createdAt;
    }
}
