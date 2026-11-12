<?php

declare(strict_types=1);

namespace App\Sync\Calendar;

/**
 * The API's calendars for the listed ones, and the account's calendar status after the list, so the worker knows
 * whether a problem it reported still stands (the list keeps `error`, and makes any other status `active`).
 */
final readonly class CalendarListResult
{
    /**
     * @param list<array{remoteId: string, id: string, cursor: ?string}> $calendars
     */
    public function __construct(public array $calendars, public string $calendarStatus)
    {
    }
}
