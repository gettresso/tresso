<?php

declare(strict_types=1);

namespace App\State;

use ApiPlatform\Metadata\Operation;
use ApiPlatform\State\ProviderInterface;
use App\ApiResource\ChatMediaResource;
use App\Chat\ChatMedia;
use App\Chat\ChatMediaViews;
use App\Security\CurrentUser;
use App\Security\FirstPartyClients;
use Symfony\Bundle\SecurityBundle\Security;

/**
 * Where the file of one of the signed-in user's chat messages stands, with a link once it may be downloaded, for our own
 * apps only: any other caller with `chat:read` (an app that is not ours, an MCP client, a personal access token) sees
 * where it stands and never gets a link.
 *
 * @implements ProviderInterface<ChatMediaResource>
 */
final readonly class ChatMediaProvider implements ProviderInterface
{
    public function __construct(
        private ChatMedia $media,
        private ChatMediaViews $views,
        private CurrentUser $currentUser,
        private Security $security,
    ) {
    }

    public function provide(Operation $operation, array $uriVariables = [], array $context = []): ChatMediaResource
    {
        return $this->views->resource($this->media->find($this->currentUser->get(), $uriVariables['messageId'] ?? null), false, FirstPartyClients::signedRequest($this->security->getToken()));
    }
}
