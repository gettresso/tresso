<?php

declare(strict_types=1);

namespace App\State;

use ApiPlatform\Metadata\DeleteOperationInterface;
use ApiPlatform\Metadata\Operation;
use ApiPlatform\State\ProcessorInterface;
use App\ApiResource\ConnectedAppResource;
use App\Repository\OAuthConsentRepository;
use App\Security\CurrentUser;
use App\Security\OAuth\ConnectedApps;
use Symfony\Component\HttpKernel\Exception\NotFoundHttpException;

/**
 * Disconnects one of the signed-in user's connected apps.
 *
 * @implements ProcessorInterface<ConnectedAppResource, null>
 */
final readonly class ConnectedAppProcessor implements ProcessorInterface
{
    public function __construct(
        private OAuthConsentRepository $consents,
        private ConnectedApps $connectedApps,
        private CurrentUser $currentUser,
    ) {
    }

    public function process(mixed $data, Operation $operation, array $uriVariables = [], array $context = []): null
    {
        if (!$operation instanceof DeleteOperationInterface) {
            throw new \LogicException(\sprintf('Unexpected operation %s.', $operation->getName()));
        }

        $id = $uriVariables['id'] ?? null;
        $consent = (\is_string($id) ? $this->consents->findOneOwnedBy($this->currentUser->get(), $id) : null)
            ?? throw new NotFoundHttpException('Connected app not found.');
        $this->connectedApps->disconnect($consent);

        return null;
    }
}
