<?php

declare(strict_types=1);

namespace App\State;

use ApiPlatform\Metadata\Operation;
use ApiPlatform\State\ProviderInterface;
use App\ApiResource\ChatResource;
use App\Chat\ChatViews;
use App\Entity\Chat;
use App\Repository\ChatRepository;
use App\Security\CurrentUser;
use Symfony\Component\HttpKernel\Exception\NotFoundHttpException;

/**
 * Only ever returns the signed-in user's own chats: another user's id is not found.
 *
 * @implements ProviderInterface<ChatResource>
 */
final readonly class ChatProvider implements ProviderInterface
{
    public function __construct(
        private ChatRepository $chats,
        private ChatViews $views,
        private CurrentUser $currentUser,
    ) {
    }

    public function provide(Operation $operation, array $uriVariables = [], array $context = []): ChatResource
    {
        $id = $uriVariables['id'] ?? null;
        $chat = \is_string($id) ? $this->chats->findOneOwnedBy($this->currentUser->get(), $id) : null;
        if (!$chat instanceof Chat) {
            throw new NotFoundHttpException('Chat not found.');
        }

        return ChatResource::fromView($this->views->chat($chat));
    }
}
