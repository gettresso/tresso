<?php

declare(strict_types=1);

namespace App\State;

use ApiPlatform\Metadata\Operation;
use ApiPlatform\State\ProcessorInterface;
use App\ApiResource\Input\CompleteProviderAuthorization;
use App\ApiResource\ProviderConnection;
use App\Enum\ProviderFeature;
use App\ProviderAuth\ProviderConnector;
use App\Security\CurrentUser;

/**
 * @implements ProcessorInterface<CompleteProviderAuthorization, ProviderConnection>
 */
final readonly class ProviderConnectionProcessor implements ProcessorInterface
{
    public function __construct(
        private ProviderConnector $connector,
        private CurrentUser $currentUser,
    ) {
    }

    public function process(mixed $data, Operation $operation, array $uriVariables = [], array $context = []): ProviderConnection
    {
        $provider = $data->provider ?? throw new \LogicException('Validation guarantees a provider.');
        $state = $data->state ?? throw new \LogicException('Validation guarantees a state.');

        $outcome = $this->connector->complete($this->currentUser->get(), $provider, $state, $data->code, $data->error, $data->errorDescription);
        $values = static fn (array $features): array => array_map(static fn (ProviderFeature $feature): string => $feature->value, $features);

        return new ProviderConnection(
            $provider->value,
            $outcome->connected,
            $outcome->grant,
            $outcome->error?->value,
            $values($outcome->requested),
            $values($outcome->missing),
            $outcome->existing,
            $outcome->approvalUrl,
        );
    }
}
