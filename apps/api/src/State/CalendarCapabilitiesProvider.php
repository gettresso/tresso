<?php

declare(strict_types=1);

namespace App\State;

use ApiPlatform\Metadata\Operation;
use ApiPlatform\State\ProviderInterface;
use App\ApiResource\CalendarCapabilities;
use App\Calendar\Assistant\EventDraftInterpreter;
use App\Calendar\Assistant\EventExtractor;
use App\Calendar\Assistant\MeetingBriefWriter;
use App\Calendar\Assistant\MeetingTimeFinder;

/**
 * @implements ProviderInterface<CalendarCapabilities>
 */
final readonly class CalendarCapabilitiesProvider implements ProviderInterface
{
    public function __construct(
        private EventDraftInterpreter $interpreter,
        private MeetingTimeFinder $finder,
        private EventExtractor $extractor,
        private MeetingBriefWriter $briefs,
    ) {
    }

    public function provide(Operation $operation, array $uriVariables = [], array $context = []): CalendarCapabilities
    {
        return new CalendarCapabilities(
            $this->interpreter->isAvailable(),
            true,
            $this->finder->knowsAttendeeAvailability(),
            true,
            $this->extractor->readsText(),
            true,
            $this->briefs->writesSummaries(),
            true,
        );
    }
}
