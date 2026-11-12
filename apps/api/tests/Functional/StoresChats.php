<?php

declare(strict_types=1);

namespace App\Tests\Functional;

use App\Chat\ChatFields;
use App\Entity\Chat;
use App\Entity\ChatAccount;
use App\Entity\ChatMessage;
use App\Entity\ChatOutgoing;
use App\Entity\User;
use App\Enum\ChatChannel;
use App\Enum\ChatKind;
use App\Enum\ChatMediaKind;
use Doctrine\ORM\EntityManagerInterface;
use Symfony\Component\Uid\Uuid;

/**
 * Stores chat accounts, chats, messages and replies through {@see ChatFields}, as the relay endpoints do.
 */
trait StoresChats
{
    protected function chatFields(): ChatFields
    {
        return static::getContainer()->get(ChatFields::class);
    }

    protected function chatEntityManager(): EntityManagerInterface
    {
        return static::getContainer()->get(EntityManagerInterface::class);
    }

    protected function storeChatAccount(User $owner, ?string $address = '31698765432', ?string $displayName = 'Kim Visser'): ChatAccount
    {
        return $this->chatEntityManager()->wrapInTransaction(function (EntityManagerInterface $entityManager) use ($owner, $address, $displayName): ChatAccount {
            $account = new ChatAccount($owner, ChatChannel::WhatsApp, Uuid::v7(), 'Kim\'s MacBook Pro', true, false, new \DateTimeImmutable());
            $this->chatFields()->setAccountIdentity($account, $address, $displayName);
            $entityManager->persist($account);

            return $account;
        });
    }

    protected function findChatAccount(string $id): ChatAccount
    {
        $account = $this->chatEntityManager()->find(ChatAccount::class, Uuid::fromString($id));
        self::assertInstanceOf(ChatAccount::class, $account);

        return $account;
    }

    protected function storeChat(ChatAccount $account, string $jid, ?string $name, ChatKind $kind = ChatKind::Direct): Chat
    {
        return $this->chatEntityManager()->wrapInTransaction(function (EntityManagerInterface $entityManager) use ($account, $jid, $name, $kind): Chat {
            $chat = $this->chatFields()->newChat($account, $jid, $name, $kind, new \DateTimeImmutable('2026-11-12 09:30:00'));
            $entityManager->persist($chat);

            return $chat;
        });
    }

    /**
     * Messages stored in one transaction share one change number.
     *
     * @param list<array{waId: string, text: string, fromMe?: bool, sender?: array{id: string, name: ?string}|null, media?: array{ChatMediaKind, ?string, ?int}}> $messages
     *
     * @return list<ChatMessage>
     */
    protected function storeChatMessages(Chat $chat, array $messages): array
    {
        return $this->chatEntityManager()->wrapInTransaction(function (EntityManagerInterface $entityManager) use ($chat, $messages): array {
            $stored = [];
            foreach ($messages as $i => $message) {
                $media = $message['media'] ?? null;
                $stored[] = $entity = $this->chatFields()->newMessage(
                    $chat,
                    $message['waId'],
                    $message['fromMe'] ?? false,
                    new \DateTimeImmutable('2026-11-12 09:00:00')->modify('+'.$i.' minutes'),
                    $message['sender'] ?? null,
                    $message['text'],
                    $media[0] ?? null,
                    $media[1] ?? null,
                    $media[2] ?? null,
                );
                $entityManager->persist($entity);
            }

            return $stored;
        });
    }

    protected function storeChatOutgoing(Chat $chat, string $text): ChatOutgoing
    {
        return $this->chatEntityManager()->wrapInTransaction(function (EntityManagerInterface $entityManager) use ($chat, $text): ChatOutgoing {
            $outgoing = $this->chatFields()->newOutgoing(Uuid::v7(), $chat, $text, new \DateTimeImmutable());
            $entityManager->persist($outgoing);

            return $outgoing;
        });
    }

    /**
     * Rows in the four chat tables.
     *
     * @return array{chat_account: int, chat: int, chat_message: int, chat_outgoing: int}
     */
    protected function chatRowCounts(): array
    {
        $count = function (string $table): int {
            $rows = static::getContainer()->get(EntityManagerInterface::class)->getConnection()->fetchOne('SELECT COUNT(*) FROM '.$table);
            self::assertIsInt($rows);

            return $rows;
        };

        return ['chat_account' => $count('chat_account'), 'chat' => $count('chat'), 'chat_message' => $count('chat_message'), 'chat_outgoing' => $count('chat_outgoing')];
    }
}
