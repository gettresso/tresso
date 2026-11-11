<?php

declare(strict_types=1);

namespace App\State;

use ApiPlatform\Metadata\Operation;
use ApiPlatform\State\ProviderInterface;
use App\ApiResource\NotificationSettingsResource;
use App\Notification\NotificationEmailAddress;
use App\Repository\NotificationPreferencesRepository;
use App\Security\CurrentUser;

/**
 * @implements ProviderInterface<NotificationSettingsResource>
 */
final readonly class NotificationSettingsProvider implements ProviderInterface
{
    public function __construct(
        private NotificationPreferencesRepository $preferences,
        private CurrentUser $currentUser,
        private NotificationEmailAddress $emailAddresses,
    ) {
    }

    public function provide(Operation $operation, array $uriVariables = [], array $context = []): NotificationSettingsResource
    {
        $user = $this->currentUser->get();
        $preferences = $this->preferences->forUser($user);

        return NotificationSettingsResource::fromEntity($preferences, $this->emailAddresses->effective($user, $preferences));
    }
}
