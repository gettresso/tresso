<?php

declare(strict_types=1);

namespace App\State;

use ApiPlatform\Metadata\Operation;
use ApiPlatform\State\ProviderInterface;
use App\ApiResource\MeetingPreferencesResource;
use App\Calendar\MeetingApps;
use App\Repository\MeetingPreferencesRepository;
use App\Security\CurrentUser;

/**
 * @implements ProviderInterface<MeetingPreferencesResource>
 */
final readonly class MeetingPreferencesProvider implements ProviderInterface
{
    public function __construct(
        private MeetingPreferencesRepository $preferences,
        private MeetingApps $apps,
        private CurrentUser $currentUser,
    ) {
    }

    public function provide(Operation $operation, array $uriVariables = [], array $context = []): MeetingPreferencesResource
    {
        return MeetingPreferencesResource::fromEntity($this->preferences->forUser($this->currentUser->get()), $this->apps->offered());
    }
}
