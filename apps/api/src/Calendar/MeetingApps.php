<?php

declare(strict_types=1);

namespace App\Calendar;

/**
 * The meeting apps this server can offer. Google Meet and Microsoft Teams are made by the calendar provider as part of
 * saving an event, so every server has them; the own link needs nothing. Zoom needs an app registered at Zoom and is
 * not offered yet.
 */
final readonly class MeetingApps
{
    /**
     * @return list<string> a subset of {@see \App\Entity\MeetingPreferences::APPS}, in the order clients show them
     */
    public function offered(): array
    {
        return ['meet', 'teams', 'own'];
    }
}
