<?php

declare(strict_types=1);

namespace App\State;

use ApiPlatform\Metadata\Operation;
use ApiPlatform\State\ProcessorInterface;
use App\ApiResource\ChatMediaResource;
use App\ApiResource\ChatProblem;
use App\ApiResource\Input\ConfirmUnscannedInput;
use App\Chat\ChatMedia;
use App\Chat\ChatMediaViews;
use App\Enum\ChatMediaState;
use App\Scan\DownloadPolicy;
use App\Security\CurrentUser;
use Doctrine\ORM\EntityManagerInterface;

/**
 * Asks the relaying Mac for a chat message's file, and gives the link for one that could not be scanned to a user who
 * confirmed they accept that.
 *
 * @implements ProcessorInterface<ConfirmUnscannedInput|null, ChatMediaResource>
 */
final readonly class ChatMediaProcessor implements ProcessorInterface
{
    public function __construct(
        private ChatMedia $media,
        private ChatMediaViews $views,
        private DownloadPolicy $downloads,
        private CurrentUser $currentUser,
        private EntityManagerInterface $entityManager,
    ) {
    }

    public function process(mixed $data, Operation $operation, array $uriVariables = [], array $context = []): ChatMediaResource
    {
        $user = $this->currentUser->get();
        if (ChatMediaResource::REQUEST === $operation->getName()) {
            $resource = $this->views->resource($this->media->request($user, $uriVariables['messageId'] ?? null, new \DateTimeImmutable()), false);
            $this->entityManager->clear();

            return $resource;
        }

        $message = $this->media->find($user, $uriVariables['messageId'] ?? null);
        $status = $message->getMediaScanStatus();
        if (ChatMediaState::Stored !== $message->getMediaState() || null === $status) {
            throw ChatProblem::notStored();
        }
        $resource = $this->views->resource($message, true);
        if (null === $resource->url) {
            throw $this->downloads->refusal($status) ?? new \LogicException('A stored file without a link has a reason for it.');
        }

        return $resource;
    }
}
