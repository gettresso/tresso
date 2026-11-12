<?php

declare(strict_types=1);

namespace App\State;

use ApiPlatform\Metadata\DeleteOperationInterface;
use ApiPlatform\Metadata\Operation;
use ApiPlatform\State\ProcessorInterface;
use App\ApiResource\ChatOutgoingResource;
use App\ApiResource\Input\Chat\QueueReply;
use App\Chat\ChatQueue;
use App\Chat\ChatViews;
use App\Security\CurrentUser;
use Doctrine\ORM\EntityManagerInterface;
use Symfony\Component\HttpFoundation\Request;
use Symfony\Component\HttpFoundation\Response;

/**
 * Queues, cancels and retries the signed-in user's replies ({@see ChatQueue}). Who may is decided by the operation's
 * security ({@see \App\Security\ChatAccessVoter::SEND}); everything is loaded through the user, so another user's chat
 * or reply is not found.
 *
 * @implements ProcessorInterface<QueueReply|ChatOutgoingResource|null, ChatOutgoingResource|null>
 */
final readonly class ChatOutgoingProcessor implements ProcessorInterface
{
    public function __construct(
        private ChatQueue $queue,
        private ChatViews $views,
        private CurrentUser $currentUser,
        private EntityManagerInterface $entityManager,
    ) {
    }

    public function process(mixed $data, Operation $operation, array $uriVariables = [], array $context = []): ?ChatOutgoingResource
    {
        $user = $this->currentUser->get();

        if ($data instanceof QueueReply) {
            [$outgoing, $queued] = $this->queue->queue($user, $uriVariables['chatId'] ?? null, $data, new \DateTimeImmutable());
            if (!$queued) {
                // The same request again: the reply it queued the first time, as it is now.
                $request = $context['request'] ?? null;
                if ($request instanceof Request) {
                    $request->attributes->set('_api_response_status', Response::HTTP_OK);
                }
            }
            $resource = ChatOutgoingResource::fromView($this->views->outgoing($outgoing));
        } elseif ($operation instanceof DeleteOperationInterface) {
            $this->queue->cancel($user, $uriVariables['id'] ?? null);
            $resource = null;
        } elseif ('chat_outgoing_retry' === $operation->getName()) {
            $resource = ChatOutgoingResource::fromView($this->views->outgoing($this->queue->retry($user, $uriVariables['id'] ?? null)));
        } else {
            throw new \LogicException(\sprintf('Unexpected input %s for %s.', get_debug_type($data), $operation->getName()));
        }
        $this->entityManager->clear();

        return $resource;
    }
}
