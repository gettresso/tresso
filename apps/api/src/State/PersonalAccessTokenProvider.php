<?php

declare(strict_types=1);

namespace App\State;

use ApiPlatform\Metadata\CollectionOperationInterface;
use ApiPlatform\Metadata\Operation;
use ApiPlatform\State\ProviderInterface;
use App\ApiResource\PersonalAccessTokenResource;
use App\Entity\PersonalAccessToken;
use App\Repository\PersonalAccessTokenRepository;
use App\Security\CurrentUser;
use Symfony\Component\HttpKernel\Exception\NotFoundHttpException;

/**
 * Only ever returns the signed-in user's own tokens, newest first.
 *
 * @implements ProviderInterface<PersonalAccessTokenResource>
 */
final readonly class PersonalAccessTokenProvider implements ProviderInterface
{
    public function __construct(
        private PersonalAccessTokenRepository $tokens,
        private CurrentUser $currentUser,
    ) {
    }

    /**
     * @return PersonalAccessTokenResource|list<PersonalAccessTokenResource>
     */
    public function provide(Operation $operation, array $uriVariables = [], array $context = []): PersonalAccessTokenResource|array
    {
        $owner = $this->currentUser->get();

        if ($operation instanceof CollectionOperationInterface) {
            return array_map(PersonalAccessTokenResource::fromEntity(...), $this->tokens->findOwnedBy($owner));
        }

        $id = $uriVariables['id'] ?? null;
        $token = \is_string($id) ? $this->tokens->findOneOwnedBy($owner, $id) : null;
        if (!$token instanceof PersonalAccessToken) {
            throw new NotFoundHttpException('Personal access token not found.');
        }

        return PersonalAccessTokenResource::fromEntity($token);
    }
}
