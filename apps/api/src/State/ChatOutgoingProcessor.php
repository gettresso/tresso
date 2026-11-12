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
use ApiPlatform\Validator\Exception\ValidationException;
use Doctrine\ORM\EntityManagerInterface;
use Symfony\Component\HttpFoundation\Request;
use Symfony\Component\HttpFoundation\Response;
use Symfony\Component\HttpKernel\Exception\BadRequestHttpException;
use Symfony\Component\Serializer\Exception\ExceptionInterface as SerializerExceptionInterface;
use Symfony\Component\Serializer\SerializerInterface;
use Symfony\Component\Validator\Validator\ValidatorInterface;

/**
 * Queues, cancels and retries the signed-in user's replies ({@see ChatQueue}). Who may is decided by the operation's
 * security ({@see \App\Security\ChatAccessVoter::SEND}); everything is loaded through the user, so another user's chat
 * or reply is not found.
 *
 * @implements ProcessorInterface<ChatOutgoingResource|null, ChatOutgoingResource|null>
 */
final readonly class ChatOutgoingProcessor implements ProcessorInterface
{
    public function __construct(
        private ChatQueue $queue,
        private ChatViews $views,
        private CurrentUser $currentUser,
        private EntityManagerInterface $entityManager,
        private SerializerInterface $serializer,
        private ValidatorInterface $validator,
    ) {
    }

    public function process(mixed $data, Operation $operation, array $uriVariables = [], array $context = []): ?ChatOutgoingResource
    {
        $user = $this->currentUser->get();
        $request = $context['request'] ?? null;

        if ('chat_outgoing_queue' === $operation->getName()) {
            if (!$request instanceof Request) {
                throw new \LogicException('Queueing a reply needs the request.');
            }
            [$outgoing, $queued] = $this->queue->queue($user, $uriVariables['chatId'] ?? null, $this->reply($request), new \DateTimeImmutable());
            if (!$queued) {
                // The same request again: the reply it queued the first time, as it is now.
                $request->attributes->set('_api_response_status', Response::HTTP_OK);
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

    /**
     * The body as a {@see QueueReply}, validated. Nothing of it is repeated in an error.
     */
    private function reply(Request $request): QueueReply
    {
        try {
            $reply = $this->serializer->deserialize($request->getContent(), QueueReply::class, 'json');
        } catch (SerializerExceptionInterface) {
            throw new BadRequestHttpException('The body is not a reply: send {"id": "<UUIDv7>", "text": "..."}.');
        }
        $violations = $this->validator->validate($reply);
        if (\count($violations) > 0) {
            throw new ValidationException($violations);
        }

        return $reply;
    }
}
