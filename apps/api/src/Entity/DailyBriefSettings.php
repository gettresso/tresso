<?php

declare(strict_types=1);

namespace App\Entity;

use App\Brief\BriefTime;
use App\Repository\DailyBriefSettingsRepository;
use Doctrine\ORM\Mapping as ORM;

/**
 * Whether and when the user gets their daily brief of `know` mail. The time is read in the user's notification time
 * zone, and where the brief goes besides the app follows their notification preferences (kind `daily_brief`). Every
 * user has one, made with the user (older users get theirs from an hourly backfill).
 */
#[ORM\Entity(repositoryClass: DailyBriefSettingsRepository::class)]
#[ORM\Index(name: 'daily_brief_settings_due', columns: ['next_run_at'], options: ['where' => '(enabled = true)'])]
class DailyBriefSettings
{
    public const bool DEFAULT_ENABLED = true;
    public const string DEFAULT_DELIVER_AT = '08:00';

    #[ORM\Id]
    #[ORM\OneToOne]
    #[ORM\JoinColumn(nullable: false, onDelete: 'CASCADE')]
    private User $user;

    #[ORM\Column]
    private bool $enabled = self::DEFAULT_ENABLED;

    /** HH:MM in the user's notification time zone. */
    #[ORM\Column(length: 5)]
    private string $deliverAt = self::DEFAULT_DELIVER_AT;

    /** The next brief is made at this moment; it moves on after each run and when the time or the zone changes. */
    #[ORM\Column]
    private \DateTimeImmutable $nextRunAt;

    /**
     * While a failed run waits for its retry (then in nextRunAt): the moment the brief was due. The brief keeps the
     * day it was due on, however late the retry comes. Null otherwise.
     */
    #[ORM\Column(nullable: true)]
    private ?\DateTimeImmutable $dueAt = null;

    /** The last brief covered mail classified up to here; null before the first run. */
    #[ORM\Column(nullable: true)]
    private ?\DateTimeImmutable $coveredUntil = null;

    /**
     * The local day (Y-m-d, in the zone of that run) the last brief was due on; the next one comes on a later day. The
     * day it was due, not the day it was made: a 23:59 brief made just after midnight leaves the new day its own.
     */
    #[ORM\Column(length: 10, nullable: true)]
    private ?string $lastDueDay = null;

    public function __construct(User $user, string $timeZone, \DateTimeImmutable $now)
    {
        $this->user = $user;
        $this->nextRunAt = BriefTime::nextRun($this->deliverAt, $timeZone, $now);
    }

    public function getUser(): User
    {
        return $this->user;
    }

    public function isEnabled(): bool
    {
        return $this->enabled;
    }

    public function getDeliverAt(): string
    {
        return $this->deliverAt;
    }

    public function getNextRunAt(): \DateTimeImmutable
    {
        return $this->nextRunAt;
    }

    public function getCoveredUntil(): ?\DateTimeImmutable
    {
        return $this->coveredUntil;
    }

    public function change(bool $enabled, string $deliverAt, string $timeZone, \DateTimeImmutable $now): void
    {
        $this->enabled = $enabled;
        $this->deliverAt = $deliverAt;
        $this->reschedule($timeZone, $now);
    }

    /**
     * The user's zone changed (or the time did): the next brief comes at the delivery time in that zone, and not again
     * today when today's brief was made already.
     */
    public function reschedule(string $timeZone, \DateTimeImmutable $now): void
    {
        $this->dueAt = null;
        $this->nextRunAt = BriefTime::nextRun($this->deliverAt, $timeZone, $now, $this->lastDueDay);
    }

    /**
     * A run made the brief that was due at the next run time, up to $until: the next one covers what comes after, at
     * the delivery time on a later day than this one was due on.
     */
    public function ran(\DateTimeImmutable $until, string $timeZone, \DateTimeImmutable $now): void
    {
        $this->coveredUntil = $until;
        $this->lastDueDay = BriefTime::localDay($this->dueAt ?? $this->nextRunAt, $timeZone);
        $this->reschedule($timeZone, $now);
    }

    public function getLastDueDay(): ?string
    {
        return $this->lastDueDay;
    }

    /**
     * Whether the brief now due was made already: it is due on the day the last one was (another sweep made it as
     * this one claimed the row, or the clock repeated the hour).
     */
    public function isDueBriefMade(string $timeZone): bool
    {
        return null !== $this->lastDueDay && BriefTime::localDay($this->dueAt ?? $this->nextRunAt, $timeZone) <= $this->lastDueDay;
    }

    /**
     * The run failed: it is tried again at $until, as the brief that was due before. The sweep writes the same in SQL
     * ({@see \App\Repository\DailyBriefSettingsRepository::postpone()}), since a failed flush leaves no entity to use.
     */
    public function postpone(\DateTimeImmutable $until): void
    {
        $this->dueAt ??= $this->nextRunAt;
        $this->nextRunAt = $until;
    }

    public function getDueAt(): ?\DateTimeImmutable
    {
        return $this->dueAt;
    }
}
