<?php

declare(strict_types=1);

namespace App\State;

use ApiPlatform\Metadata\DeleteOperationInterface;
use ApiPlatform\Metadata\Operation;
use ApiPlatform\State\ProcessorInterface;
use ApiPlatform\Validator\Exception\ValidationException;
use App\ApiResource\ConnectedAppResource;
use App\ApiResource\Input\UpdateConnectedApp;
use App\Repository\OAuthConsentRepository;
use App\Security\CurrentUser;
use App\Security\OAuth\ConnectedApps;
use Symfony\Component\HttpKernel\Exception\NotFoundHttpException;
use Symfony\Component\Validator\ConstraintViolation;
use Symfony\Component\Validator\ConstraintViolationList;

/**
 * Narrows or disconnects one of the signed-in user's connected apps.
 *
 * @implements ProcessorInterface<ConnectedAppResource|UpdateConnectedApp, ConnectedAppResource|null>
 */
final readonly class ConnectedAppProcessor implements ProcessorInterface
{
    public function __construct(
        private OAuthConsentRepository $consents,
        private ConnectedApps $connectedApps,
        private CurrentUser $currentUser,
    ) {
    }

    public function process(mixed $data, Operation $operation, array $uriVariables = [], array $context = []): ?ConnectedAppResource
    {
        $id = $uriVariables['id'] ?? null;
        $consent = (\is_string($id) ? $this->consents->findOneOwnedBy($this->currentUser->get(), $id) : null)
            ?? throw new NotFoundHttpException('Connected app not found.');

        if ($data instanceof UpdateConnectedApp) {
            $scopes = $data->scopes ?? throw new \LogicException('Validation guarantees the scopes.');
            $beyond = array_values(array_diff($scopes, $consent->getScopes()));
            if ([] !== $beyond) {
                throw new ValidationException(new ConstraintViolationList([new ConstraintViolation(
                    \sprintf('You did not give %s this permission when you connected it. To give it, connect the app again and allow it there.', $consent->getClient()->getName()),
                    null,
                    [],
                    $data,
                    'scopes',
                    $beyond,
                )]));
            }

            return ConnectedAppResource::fromEntity($this->connectedApps->narrow($consent, $scopes));
        }

        if (!$operation instanceof DeleteOperationInterface) {
            throw new \LogicException(\sprintf('Unexpected operation %s.', $operation->getName()));
        }
        $this->connectedApps->disconnect($consent);

        return null;
    }
}
