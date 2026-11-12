<?php

declare(strict_types=1);

namespace App\State;

use ApiPlatform\Metadata\Operation;
use ApiPlatform\State\ProviderInterface;
use App\ApiResource\ChatOutgoingResource;
use App\Chat\ChatViews;
use App\Entity\ChatOutgoing;
use App\Repository\ChatOutgoingRepository;
use App\Security\CurrentUser;
use Symfony\Component\HttpKernel\Exception\NotFoundHttpException;

/**
 * Only ever returns the signed-in user's own replies: another user's id is not found.
 *
 * @implements ProviderInterface<ChatOutgoingResource>
 */
final readonly class ChatOutgoingProvider implements ProviderInterface
{
    public function __construct(
        private ChatOutgoingRepository $outgoing,
        private ChatViews $views,
        private CurrentUser $currentUser,
    ) {
    }

    public function provide(Operation $operation, array $uriVariables = [], array $context = []): ChatOutgoingResource
    {
        $id = $uriVariables['id'] ?? null;
        $outgoing = \is_string($id) ? $this->outgoing->findOneOwnedBy($this->currentUser->get(), $id) : null;
        if (!$outgoing instanceof ChatOutgoing) {
            throw new NotFoundHttpException('Reply not found.');
        }

        return ChatOutgoingResource::fromView($this->views->outgoing($outgoing));
    }
}
