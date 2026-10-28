<?php

declare(strict_types=1);

namespace App\Calendar\Assistant;

use App\Entity\CalendarEvent;

/**
 * Prepares the brief for a meeting. The built-in writer lists the people and the recent conversations with them from
 * mail metadata; planned AI features would decorate this service to add a summary of the related mail and todos.
 */
interface MeetingBriefWriter
{
    /** Whether briefs carry a written summary, so clients know to show one (`GET /api/v1/calendar/capabilities`). */
    public function writesSummaries(): bool;

    /**
     * @param string $occurrenceKey '' for a single event
     */
    public function brief(CalendarEvent $event, string $occurrenceKey): MeetingBrief;
}
