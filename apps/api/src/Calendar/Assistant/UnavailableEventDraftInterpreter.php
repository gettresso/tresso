<?php

declare(strict_types=1);

namespace App\Calendar\Assistant;

use App\Entity\User;
use Symfony\Component\DependencyInjection\Attribute\AsAlias;

/**
 * Tresso reads no free text on its own: a rule-based reading of dates in every language would guess wrong too often
 * to be worth offering, so the capability is off and clients do not show it.
 */
#[AsAlias(EventDraftInterpreter::class)]
final readonly class UnavailableEventDraftInterpreter implements EventDraftInterpreter
{
    public function isAvailable(): bool
    {
        return false;
    }

    public function interpret(User $user, string $text, \DateTimeZone $zone, \DateTimeImmutable $now): EventDraft
    {
        throw new AssistantUnavailable('Creating events from text is not available on this server.');
    }
}
