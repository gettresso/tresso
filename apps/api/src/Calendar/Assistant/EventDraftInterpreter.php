<?php

declare(strict_types=1);

namespace App\Calendar\Assistant;

use App\Entity\User;

/**
 * Turns free text ("lunch with Sam Thursday 12:30 at Café Loos") into an event draft. Tresso has no built-in
 * interpreter ({@see UnavailableEventDraftInterpreter}); an AI version decorates it with one.
 */
interface EventDraftInterpreter
{
    public function isAvailable(): bool;

    /**
     * @param \DateTimeZone      $zone the user's zone, for "Thursday 12:30"
     * @param \DateTimeImmutable $now  what "Thursday" counts from
     *
     * @throws AssistantUnavailable when this edition has no interpreter
     */
    public function interpret(User $user, string $text, \DateTimeZone $zone, \DateTimeImmutable $now): EventDraft;
}
