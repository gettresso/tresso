<?php

declare(strict_types=1);

namespace App\State;

use ApiPlatform\Metadata\Operation;
use ApiPlatform\State\ProcessorInterface;
use App\ApiResource\ChatResource;
use App\ApiResource\Input\Chat\UpdateChat;
use App\Chat\ChatMediaCollector;
use App\Chat\ChatOwnerLock;
use App\Chat\ChatTime;
use App\Chat\ChatViews;
use App\Entity\Chat;
use App\Entity\ChatMessage;
use App\Entity\ChatOutgoing;
use App\Repository\ChatRepository;
use App\Security\CurrentUser;
use App\Sync\Change\ChangeSequencer;
use Doctrine\DBAL\Connection;
use Doctrine\ORM\EntityManagerInterface;
use Symfony\Component\HttpKernel\Exception\NotFoundHttpException;

/**
 * Changes Tresso's own state of a chat of the signed-in user: read and archived through a time (only forward), back in
 * the inbox, left out or taken again. Who may is decided by the operation's security
 * ({@see \App\Security\ChatAccessVoter::MANAGE}); the chat is loaded through the user, so another user's is not found.
 *
 * Leaving a chat out removes its messages and replies from the server (a tombstone each, so clients drop them), with
 * every file they held and the uploads waiting in it ({@see ChatMediaCollector}), and keeps
 * the chat, so the relay knows to leave it out ({@see \App\Chat\ChatIngestor}); taking it in again stores what the relay
 * sends from then on.
 *
 * @implements ProcessorInterface<UpdateChat, ChatResource>
 */
final readonly class ChatProcessor implements ProcessorInterface
{
    public function __construct(
        private EntityManagerInterface $entityManager,
        private Connection $connection,
        private ChatRepository $chats,
        private ChatViews $views,
        private ChatOwnerLock $ownerLock,
        private ChangeSequencer $sequencer,
        private CurrentUser $currentUser,
        private ChatMediaCollector $collector,
    ) {
    }

    public function process(mixed $data, Operation $operation, array $uriVariables = [], array $context = []): ChatResource
    {
        $user = $this->currentUser->get();
        $id = $uriVariables['id'] ?? null;

        $resource = $this->entityManager->wrapInTransaction(function () use ($user, $id, $data): ChatResource {
            $this->ownerLock->lock($user->getId());
            $chat = \is_string($id) ? $this->chats->findOneOwnedBy($user, $id) : null;
            if (!$chat instanceof Chat) {
                throw new NotFoundHttpException('Chat not found.');
            }
            $this->entityManager->refresh($chat);

            if (null !== $data->readThrough) {
                $chat->readThrough(ChatTime::stored($data->readThrough));
            }
            if ($data->changesArchive()) {
                $archivedThrough = $data->getArchivedThrough();
                $chat->archiveThrough(null === $archivedThrough ? null : ChatTime::stored($archivedThrough));
            }
            if (true === $data->leftOut && !$chat->isLeftOut()) {
                $this->removeContent($chat);
            }
            if (null !== $data->leftOut) {
                $chat->setLeftOut($data->leftOut);
            }
            $this->entityManager->flush();

            return ChatResource::fromView($this->views->chat($chat));
        });
        $this->entityManager->clear();

        return $resource;
    }

    /**
     * Removes the chat's messages and replies, and tells clients: a tombstone each, with a change number per
     * {@see ChangeSequencer::CHUNK} rows so a page of the delta stays bounded.
     */
    private function removeContent(Chat $chat): void
    {
        $owner = $chat->getChatAccount()->getOwner()->getId();
        $this->collector->release($this->collector->keysOf($chat->getChatAccount()->getId()->toRfc4122(), [$chat->getId()->toRfc4122()]));
        $this->connection->executeStatement('DELETE FROM chat_upload WHERE chat_id = :chat', ['chat' => $chat->getId()->toRfc4122()]);
        foreach (['chat_message' => ChatMessage::changeType(), 'chat_outgoing' => ChatOutgoing::changeType()] as $table => $type) {
            $ids = array_map(
                static fn (mixed $id): string => \is_string($id) ? $id : throw new \UnexpectedValueException('Expected an id.'),
                $this->connection->fetchFirstColumn(\sprintf('DELETE FROM %s WHERE chat_id = :chat RETURNING id', $table), ['chat' => $chat->getId()->toRfc4122()]),
            );
            foreach (array_chunk($ids, ChangeSequencer::CHUNK) as $chunk) {
                $this->sequencer->tombstones($owner, $type, $chunk, $this->sequencer->next($owner));
            }
        }
    }
}
