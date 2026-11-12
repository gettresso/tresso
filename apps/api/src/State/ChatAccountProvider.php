<?php

declare(strict_types=1);

namespace App\State;

use ApiPlatform\Metadata\CollectionOperationInterface;
use ApiPlatform\Metadata\Operation;
use ApiPlatform\State\ProviderInterface;
use App\ApiResource\ChatAccountResource;
use App\Chat\ChatViews;
use App\Entity\ChatAccount;
use App\Repository\ChatAccountRepository;
use App\Security\CurrentUser;
use Symfony\Component\HttpKernel\Exception\NotFoundHttpException;

/**
 * Only ever returns the signed-in user's own chat accounts: another user's id is not found.
 *
 * @implements ProviderInterface<ChatAccountResource>
 */
final readonly class ChatAccountProvider implements ProviderInterface
{
    public function __construct(
        private ChatAccountRepository $accounts,
        private ChatViews $views,
        private CurrentUser $currentUser,
    ) {
    }

    /**
     * @return ChatAccountResource|list<ChatAccountResource>
     */
    public function provide(Operation $operation, array $uriVariables = [], array $context = []): ChatAccountResource|array
    {
        $owner = $this->currentUser->get();

        if ($operation instanceof CollectionOperationInterface) {
            return array_map(fn (ChatAccount $account): ChatAccountResource => ChatAccountResource::fromView($this->views->account($account)), $this->accounts->findOwnedBy($owner));
        }

        $id = $uriVariables['id'] ?? null;
        $account = \is_string($id) ? $this->accounts->findOneOwnedBy($owner, $id) : null;
        if (!$account instanceof ChatAccount) {
            throw new NotFoundHttpException('Chat account not found.');
        }

        return ChatAccountResource::fromView($this->views->account($account));
    }
}
