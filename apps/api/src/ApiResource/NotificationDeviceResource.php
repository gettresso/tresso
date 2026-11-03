<?php

declare(strict_types=1);

namespace App\ApiResource;

use ApiPlatform\Metadata\ApiProperty;
use ApiPlatform\Metadata\ApiResource;
use ApiPlatform\Metadata\Delete;
use ApiPlatform\Metadata\GetCollection;
use ApiPlatform\Metadata\Patch;
use ApiPlatform\Metadata\Post;
use App\ApiResource\Input\Notification\RegisterDevice;
use App\ApiResource\Input\Notification\UpdateDevice;
use App\Entity\NotificationDevice;
use App\Enum\DeviceKind;
use App\Security\FirstPartyClients;
use App\Security\Scope;
use App\State\NotificationDeviceProcessor;
use App\State\NotificationDeviceProvider;

/**
 * A device that gets the user's notifications. Push subscription keys are written, never read back.
 */
#[ApiResource(
    shortName: 'NotificationDevice',
    routePrefix: '/api/v1',
    normalizationContext: ['skip_null_values' => false],
    operations: [
        new GetCollection(uriTemplate: '/notification-devices', paginationEnabled: false, security: "is_granted('".Scope::ROLE_SETTINGS_READ."')", provider: NotificationDeviceProvider::class),
        new Post(uriTemplate: '/notification-devices', status: 200, security: "is_granted('".Scope::ROLE_SETTINGS_WRITE."') and is_granted('".FirstPartyClients::ATTRIBUTE."')", input: RegisterDevice::class, read: false, processor: NotificationDeviceProcessor::class),
        new Patch(uriTemplate: '/notification-devices/{id}', security: "is_granted('".Scope::ROLE_SETTINGS_WRITE."')", input: UpdateDevice::class, provider: NotificationDeviceProvider::class, processor: NotificationDeviceProcessor::class),
        new Delete(uriTemplate: '/notification-devices/{id}', security: "is_granted('".Scope::ROLE_SETTINGS_WRITE."')", provider: NotificationDeviceProvider::class, processor: NotificationDeviceProcessor::class),
    ],
)]
final readonly class NotificationDeviceResource
{
    public function __construct(
        #[ApiProperty(identifier: true)]
        public string $id,
        public DeviceKind $kind,
        public string $name,
        public bool $enabled,
        public \DateTimeImmutable $createdAt,
        public \DateTimeImmutable $lastSeenAt,
    ) {
    }

    public static function fromEntity(NotificationDevice $device): self
    {
        return new self($device->getId()->toRfc4122(), $device->getKind(), $device->getName(), $device->isEnabled(), $device->getCreatedAt(), $device->getLastSeenAt());
    }
}
