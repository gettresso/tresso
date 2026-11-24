<?php

declare(strict_types=1);

namespace App\Entity;

use Doctrine\DBAL\Types\Types;
use Doctrine\ORM\Mapping as ORM;

/**
 * How many entries of the activity log one app has for a user on one day: what keeps one app from filling the log
 * ({@see \App\Activity\ActivityLog::DAILY_CAP}), and the small list of the apps a user's log has in a period, for the
 * log's app filter, without reading the log itself. Written with the log, purged with it, deleted with the user.
 */
#[ORM\Entity(readOnly: true)]
#[ORM\Table(name: 'app_activity_day')]
class AppActivityDay
{
    #[ORM\Id]
    #[ORM\ManyToOne]
    #[ORM\JoinColumn(nullable: false, onDelete: 'CASCADE')]
    private User $owner;

    #[ORM\Id]
    #[ORM\Column(length: 8)]
    private string $appType;

    #[ORM\Id]
    #[ORM\Column(length: 80)]
    private string $appId;

    #[ORM\Id]
    #[ORM\Column(type: Types::DATE_IMMUTABLE)]
    private \DateTimeImmutable $day;

    /** The entries written for the app that day (repeats of one entry count once). */
    #[ORM\Column]
    private int $entries;

    public function __construct(User $owner, string $appType, string $appId, \DateTimeImmutable $day, int $entries)
    {
        $this->owner = $owner;
        $this->appType = $appType;
        $this->appId = $appId;
        $this->day = $day;
        $this->entries = $entries;
    }

    public function getOwner(): User
    {
        return $this->owner;
    }

    public function getEntries(): int
    {
        return $this->entries;
    }
}
