<?php

declare(strict_types=1);

namespace App\ApiResource;

use ApiPlatform\Metadata\ApiResource;
use ApiPlatform\Metadata\Get;
use ApiPlatform\Metadata\QueryParameter;
use App\Calendar\Assistant\MeetingBrief;
use App\Security\Scope;
use App\State\MeetingBriefProvider;
use Symfony\Component\Validator\Constraints as Assert;

/**
 * What to know before a meeting: the people and the recent conversations with them, and a summary once a
 * planned AI feature writes one.
 *
 * @phpstan-import-type BriefPerson from MeetingBrief
 * @phpstan-import-type BriefThread from MeetingBrief
 */
#[ApiResource(
    shortName: 'MeetingBrief',
    routePrefix: '/api/v1',
    normalizationContext: ['skip_null_values' => false],
    operations: [
        new Get(
            uriTemplate: '/calendar-events/{id}/brief',
            security: "is_granted('".Scope::ROLE_CALENDAR_READ."') and is_granted('".Scope::ROLE_MAIL_READ."')",
            provider: MeetingBriefProvider::class,
            parameters: ['recurrenceId' => new QueryParameter(schema: ['type' => 'string'], constraints: [new Assert\Regex('/^\d{8}(T\d{6}Z)?$/')])],
        ),
    ],
)]
final readonly class MeetingBriefResource
{
    /**
     * @param list<BriefPerson> $people
     * @param list<BriefThread> $threads
     */
    public function __construct(
        public string $eventId,
        public ?string $recurrenceId,
        public array $people,
        public array $threads,
        public ?string $summary,
        public string $headline,
    ) {
    }
}
