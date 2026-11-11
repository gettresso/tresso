<?php

declare(strict_types=1);

namespace App\ApiResource\Input\Sync\Calendar;

use App\ApiResource\Input\Sync\WorkerRequest;
use App\Enum\CalendarSyncStatus;
use Symfony\Component\Validator\Constraints as Assert;

/**
 * Why the account's calendars do not sync: no CalDAV server, a refused login, or another problem. `active` says the
 * sync works again after an `error` (a round in which every calendar synced); it changes no other status, which the
 * calendar list itself clears.
 */
final class CalendarStatusInput extends WorkerRequest
{
    #[Assert\NotNull]
    #[Assert\Choice(choices: [CalendarSyncStatus::Active, CalendarSyncStatus::Unsupported, CalendarSyncStatus::AuthFailed, CalendarSyncStatus::Unconfirmed, CalendarSyncStatus::NotGranted, CalendarSyncStatus::Error])]
    public ?CalendarSyncStatus $status = null;

    /** Short, user-safe description of the problem. */
    #[Assert\Length(max: 500)]
    public ?string $detail = null;
}
