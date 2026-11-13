<?php

declare(strict_types=1);

namespace App\State;

use ApiPlatform\Metadata\Operation;
use ApiPlatform\State\ProviderInterface;
use App\ApiResource\MeetingPreferencesResource;
use App\Calendar\MeetingApps;
use App\Repository\MailAccountRepository;
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
        private MailAccountRepository $accounts,
        private CurrentUser $currentUser,
    ) {
    }

    public function provide(Operation $operation, array $uriVariables = [], array $context = []): MeetingPreferencesResource
    {
        $user = $this->currentUser->get();
        $accountIds = array_map(static fn ($account): string => $account->getId()->toRfc4122(), $this->accounts->findOwnedBy($user));

        return MeetingPreferencesResource::fromEntity($this->preferences->forUser($user), $this->apps->offered(), $accountIds);
    }
}
