<?php

declare(strict_types=1);

namespace App\State;

use ApiPlatform\Metadata\CollectionOperationInterface;
use ApiPlatform\Metadata\Operation;
use ApiPlatform\State\ProviderInterface;
use App\ApiResource\ConnectedAppResource;
use App\Entity\OAuthConsent;
use App\Repository\OAuthConsentRepository;
use App\Security\CurrentUser;
use Symfony\Component\HttpKernel\Exception\NotFoundHttpException;

/**
 * Only ever returns the signed-in user's own connected apps, newest first.
 *
 * @implements ProviderInterface<ConnectedAppResource>
 */
final readonly class ConnectedAppProvider implements ProviderInterface
{
    public function __construct(
        private OAuthConsentRepository $consents,
        private CurrentUser $currentUser,
    ) {
    }

    /**
     * @return ConnectedAppResource|list<ConnectedAppResource>
     */
    public function provide(Operation $operation, array $uriVariables = [], array $context = []): ConnectedAppResource|array
    {
        $user = $this->currentUser->get();

        if ($operation instanceof CollectionOperationInterface) {
            return array_map(ConnectedAppResource::fromEntity(...), $this->consents->findOwnedBy($user));
        }

        $id = $uriVariables['id'] ?? null;
        $consent = \is_string($id) ? $this->consents->findOneOwnedBy($user, $id) : null;
        if (!$consent instanceof OAuthConsent) {
            throw new NotFoundHttpException('Connected app not found.');
        }

        return ConnectedAppResource::fromEntity($consent);
    }
}
