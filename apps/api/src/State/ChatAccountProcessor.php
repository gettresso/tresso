<?php

declare(strict_types=1);

namespace App\State;

use ApiPlatform\Metadata\DeleteOperationInterface;
use ApiPlatform\Metadata\Operation;
use ApiPlatform\State\ProcessorInterface;
use App\ApiResource\ChatAccountResource;
use App\ApiResource\Input\Chat\ConnectChatAccount;
use App\ApiResource\Input\Chat\UpdateChatAccount;
use App\Chat\ChatFields;
use App\Chat\ChatOwnerLock;
use App\Chat\ChatViews;
use App\Entity\Chat;
use App\Entity\ChatAccount;
use App\Entity\User;
use App\Enum\ChatChannel;
use App\Enum\ChatKind;
use App\Repository\ChatAccountRepository;
use App\Security\CurrentUser;
use App\Sync\Change\ChangeSequencer;
use Doctrine\DBAL\Connection;
use Doctrine\DBAL\LockMode;
use Doctrine\ORM\EntityManagerInterface;
use Symfony\Component\HttpKernel\Exception\NotFoundHttpException;
use Symfony\Component\Uid\Uuid;

/**
 * Connects, changes and removes the signed-in user's chat accounts. Everything is loaded through the user: another
 * user's id is not found.
 *
 * @implements ProcessorInterface<ConnectChatAccount|UpdateChatAccount|ChatAccountResource, ChatAccountResource|null>
 */
final readonly class ChatAccountProcessor implements ProcessorInterface
{
    public function __construct(
        private EntityManagerInterface $entityManager,
        private Connection $connection,
        private ChatAccountRepository $accounts,
        private ChatFields $fields,
        private ChatViews $views,
        private ChangeSequencer $sequencer,
        private ChatOwnerLock $ownerLock,
        private CurrentUser $currentUser,
    ) {
    }

    public function process(mixed $data, Operation $operation, array $uriVariables = [], array $context = []): ?ChatAccountResource
    {
        $user = $this->currentUser->get();
        $now = new \DateTimeImmutable();

        // One transaction per write, so change numbers for client sync commit in order.
        if ($data instanceof ConnectChatAccount) {
            return $this->entityManager->wrapInTransaction(fn (): ChatAccountResource => ChatAccountResource::fromView($this->views->account($this->connect($user, $data, $now))));
        }

        $owned = $this->owned($user, $uriVariables);

        return $this->entityManager->wrapInTransaction(function () use ($user, $owned, $data, $operation): ?ChatAccountResource {
            // The owner first, then the account, as every chat write takes them ({@see ChatOwnerLock}).
            $this->ownerLock->lock($user->getId());
            $account = $this->entityManager->find(ChatAccount::class, $owned->getId(), LockMode::PESSIMISTIC_WRITE)
                ?? throw new NotFoundHttpException('Chat account not found.');

            if ($operation instanceof DeleteOperationInterface) {
                // The database removes its chats, messages and replies; clients infer that from the account's tombstone.
                $this->entityManager->remove($account);

                return null;
            }
            if (!$data instanceof UpdateChatAccount) {
                throw new \LogicException(\sprintf('Unexpected input %s for %s.', get_debug_type($data), $operation->getName()));
            }

            if (null !== $data->notify) {
                $account->setNotify($data->notify);
            }
            if (false === $data->includeGroups && $account->includesGroups()) {
                $this->removeGroupChats($account);
            }
            if (null !== $data->includeGroups) {
                $account->setIncludeGroups($data->includeGroups);
            }

            return ChatAccountResource::fromView($this->views->account($account));
        });
    }

    private function connect(User $user, ConnectChatAccount $data, \DateTimeImmutable $now): ChatAccount
    {
        // Two first connects of one user take turns, so the second finds the account the first made.
        $this->ownerLock->lock($user->getId());

        $deviceId = Uuid::fromString($data->deviceId);
        $deviceName = trim($data->deviceName);
        $account = $this->accounts->findOneByChannel($user, ChatChannel::WhatsApp);
        if (null === $account) {
            $account = new ChatAccount($user, ChatChannel::WhatsApp, $deviceId, $deviceName, $data->includeGroups, $data->notify, $now);
            $this->entityManager->persist($account);
        } else {
            $account->relayFrom($deviceId, $deviceName, $now);
        }
        $this->fields->setAccountIdentity($account, $data->address, $data->displayName);

        return $account;
    }

    /**
     * Removes the account's group chats, with their messages and replies (the database cascades), and tells clients:
     * a tombstone per chat, with a change number per {@see ChangeSequencer::CHUNK} chats so a page stays bounded.
     */
    private function removeGroupChats(ChatAccount $account): void
    {
        $owner = $account->getOwner()->getId();
        $ids = array_map(
            static fn (mixed $id): string => \is_string($id) ? $id : throw new \UnexpectedValueException('Expected a chat id.'),
            $this->connection->fetchFirstColumn(
                'DELETE FROM chat WHERE chat_account_id = :account AND kind = :group RETURNING id',
                ['account' => $account->getId()->toRfc4122(), 'group' => ChatKind::Group->value],
            ),
        );
        foreach (array_chunk($ids, ChangeSequencer::CHUNK) as $chunk) {
            $this->sequencer->tombstones($owner, Chat::changeType(), $chunk, $this->sequencer->next($owner));
        }
    }

    /**
     * @param array<string, mixed> $uriVariables
     */
    private function owned(User $user, array $uriVariables): ChatAccount
    {
        $id = $uriVariables['id'] ?? null;

        return (\is_string($id) ? $this->accounts->findOneOwnedBy($user, $id) : null)
            ?? throw new NotFoundHttpException('Chat account not found.');
    }
}
