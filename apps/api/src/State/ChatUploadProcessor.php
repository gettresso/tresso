<?php

declare(strict_types=1);

namespace App\State;

use ApiPlatform\Metadata\Operation;
use ApiPlatform\State\ProcessorInterface;
use App\ApiResource\ChatUploadResource;
use App\Chat\ChatFileBody;
use App\Chat\ChatUploads;
use App\Security\CurrentUser;
use Doctrine\ORM\EntityManagerInterface;
use Symfony\Component\HttpFoundation\Request;
use Symfony\Component\HttpFoundation\Response;

/**
 * Takes a file for a reply ({@see ChatUploads}).
 *
 * @implements ProcessorInterface<null, ChatUploadResource>
 */
final readonly class ChatUploadProcessor implements ProcessorInterface
{
    public function __construct(
        private ChatUploads $uploads,
        private ChatFileBody $body,
        private CurrentUser $currentUser,
        private EntityManagerInterface $entityManager,
    ) {
    }

    public function process(mixed $data, Operation $operation, array $uriVariables = [], array $context = []): ChatUploadResource
    {
        $request = $context['request'] ?? null;
        if (!$request instanceof Request) {
            throw new \LogicException('A file upload needs the request.');
        }
        $file = $this->body->receive($request, false);
        try {
            [$upload, $made] = $this->uploads->upload($this->currentUser->get(), $uriVariables['chatId'] ?? null, $uriVariables['id'] ?? null, $file, new \DateTimeImmutable());
        } finally {
            $file->discard();
        }
        if (!$made) {
            $request->attributes->set('_api_response_status', Response::HTTP_OK);
        }
        $resource = new ChatUploadResource($upload->getId()->toRfc4122(), $upload->getChat()->getId()->toRfc4122(), $upload->getSize());
        $this->entityManager->clear();

        return $resource;
    }
}
