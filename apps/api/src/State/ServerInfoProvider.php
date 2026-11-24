<?php

declare(strict_types=1);

namespace App\State;

use ApiPlatform\Metadata\Operation;
use ApiPlatform\State\ProviderInterface;
use App\ApiResource\ServerInfo;
use App\Billing\BillingSettings;
use App\Security\OAuth\ProtectedResources;
use Symfony\Component\DependencyInjection\Attribute\Autowire;

/**
 * @implements ProviderInterface<ServerInfo>
 */
final readonly class ServerInfoProvider implements ProviderInterface
{
    public function __construct(
        private BillingSettings $billing,
        #[Autowire(env: 'bool:MAIL_ALLOW_UNSAFE_SERVERS')]
        private bool $allowUnsafeMailServers,
        private ProtectedResources $resources,
    ) {
    }

    public function provide(Operation $operation, array $uriVariables = [], array $context = []): ServerInfo
    {
        return new ServerInfo(ServerInfo::PRODUCT, ServerInfo::API_VERSION, $this->billing->enabled, $this->billing->enabled ? BillingSettings::TRIAL_DAYS : 0, $this->allowUnsafeMailServers, $this->resources->mcpResource());
    }
}
