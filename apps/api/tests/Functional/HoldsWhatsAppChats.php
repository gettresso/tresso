<?php

declare(strict_types=1);

namespace App\Tests\Functional;

use App\Entity\Chat;
use App\Entity\ChatAccount;
use App\Entity\ChatMessage;
use App\Entity\ChatOutgoing;
use App\Entity\User;
use App\Enum\ChatKind;
use App\Enum\ChatMediaKind;
use Doctrine\ORM\EntityManagerInterface;
use Symfony\Component\Uid\Uuid;

/**
 * Kim's WhatsApp on the server, for the read endpoints and the MCP tools: a direct chat with Anna (messages, a file,
 * replies in every state), a group, a chat she left out, and Lisa's WhatsApp beside it. Times are relative to now, as
 * the search window is. Needs {@see AuthenticatesUsers} and {@see StoresChats}.
 */
trait HoldsWhatsAppChats
{
    protected const string ANNA_JID = '31612345678@s.whatsapp.net';

    protected User $kim;
    protected User $lisa;
    protected ChatAccount $kimsAccount;
    protected \DateTimeImmutable $base;
    protected string $annaChat;
    protected string $groupChat;
    protected string $leftOutChat;
    protected string $lisasChat;
    /** @var array<string, string> message and reply ids by name */
    protected array $ids = [];

    protected function setUpWhatsApp(): void
    {
        $this->bootstrapOAuthClients();
        $this->kim = $this->createUser('kim@example.test', 'Kim Visser');
        $this->lisa = $this->createUser('lisa@example.test', 'Lisa Bakker');
        $this->createUser('noor@example.test', 'Noor Jansen');
        // Two hours ago, on the second: the database keeps whole seconds.
        $this->base = new \DateTimeImmutable('@'.(time() - 7200))->setTimezone(new \DateTimeZone(date_default_timezone_get()));

        $this->kimsAccount = $this->storeChatAccount($this->kim);
        $anna = $this->chatAt($this->kimsAccount, self::ANNA_JID, 'Anna de Vries', ChatKind::Direct, 50);
        $group = $this->chatAt($this->kimsAccount, '120363025246125486@g.us', 'Project team', ChatKind::Group, 40);
        $leftOut = $this->chatAt($this->kimsAccount, '31687654321@s.whatsapp.net', 'Old club', ChatKind::Direct, 45);
        $this->annaChat = $anna->getId()->toRfc4122();
        $this->groupChat = $group->getId()->toRfc4122();
        $this->leftOutChat = $leftOut->getId()->toRfc4122();

        $anna = $this->messageAt($anna, 'friday', 0, 'Are we still on for Friday?', sender: ['id' => self::ANNA_JID, 'name' => 'Anna de Vries']);
        $this->messageAt($anna, 'yes', 10, 'Yes, 10:00', fromMe: true);
        $this->messageAt($anna, 'agenda', 20, '', sender: ['id' => self::ANNA_JID, 'name' => 'Anna de Vries'], media: [ChatMediaKind::Document, 'Agenda.pdf', 48213]);
        $this->messageAt($anna, 'see-you', 30, 'See you then', sender: ['id' => self::ANNA_JID, 'name' => 'Anna de Vries']);
        $this->messageAt($this->find($group), 'morning', 35, 'Morning all', sender: ['id' => '31600000001@s.whatsapp.net', 'name' => 'Bram']);
        $this->messageAt($this->find($leftOut), 'club', 45, 'Club dinner on Friday', sender: ['id' => '31687654321@s.whatsapp.net', 'name' => 'Club']);
        // Replies: the bridge's copy of one that went out (hidden), one sent, one waiting for the Mac.
        $this->replyAt($anna, 'echo', 'Yes, 10:00', 9, sentAfter: 10);
        $this->replyAt($anna, 'slides', 'I will bring the slides', 24, sentAfter: 25);
        $this->replyAt($anna, 'waiting', 'On my way', 60);
        $this->connection()->executeStatement('UPDATE chat SET left_out = true WHERE id = :id', ['id' => $this->leftOutChat]);

        $lisasAccount = $this->storeChatAccount($this->lisa, '31611111111', 'Lisa Bakker');
        $lisas = $this->chatAt($lisasAccount, '31622222222@s.whatsapp.net', 'Lisa\'s friend', ChatKind::Direct, 55);
        $this->lisasChat = $lisas->getId()->toRfc4122();
        $this->messageAt($lisas, 'lisa', 55, 'A Friday secret', sender: ['id' => '31622222222@s.whatsapp.net', 'name' => 'Friend']);
        // The entity manager outlives requests here; forget what it held before the change to left_out.
        $this->chatEntityManager()->clear();
    }

    /** A time $minutes after the base, as the database stores it. */
    protected function at(int $minutes): \DateTimeImmutable
    {
        return $this->base->modify(\sprintf('%+d minutes', $minutes));
    }

    protected function chatAt(ChatAccount $account, string $jid, ?string $name, ChatKind $kind, int $lastMessageAfter): Chat
    {
        return $this->chatEntityManager()->wrapInTransaction(function (EntityManagerInterface $entityManager) use ($account, $jid, $name, $kind, $lastMessageAfter): Chat {
            $chat = $this->chatFields()->newChat($account, $jid, $name, $kind, $this->at($lastMessageAfter));
            $entityManager->persist($chat);

            return $chat;
        });
    }

    /**
     * @param array{id: string, name: ?string}|null    $sender
     * @param array{ChatMediaKind, ?string, ?int}|null $media
     */
    protected function messageAt(Chat $chat, string $name, int $minutes, string $text, bool $fromMe = false, ?array $sender = null, ?array $media = null, ?\DateTimeImmutable $sentAt = null): Chat
    {
        $message = $this->chatEntityManager()->wrapInTransaction(function (EntityManagerInterface $entityManager) use ($chat, $name, $minutes, $text, $fromMe, $sender, $media, $sentAt): ChatMessage {
            $message = $this->chatFields()->newMessage($this->find($chat), 'wa-'.$name.'-'.bin2hex(random_bytes(4)), $fromMe, $sentAt ?? $this->at($minutes), $sender, $text, $media[0] ?? null, $media[1] ?? null, $media[2] ?? null);
            $entityManager->persist($message);

            return $message;
        });
        $this->ids[$name] = $message->getId()->toRfc4122();

        return $chat;
    }

    /** A reply written $minutes after the base, sent $sentAfter minutes after it when given, else waiting. */
    protected function replyAt(Chat $chat, string $name, string $text, int $minutes, ?int $sentAfter = null): ChatOutgoing
    {
        $reply = $this->chatEntityManager()->wrapInTransaction(function (EntityManagerInterface $entityManager) use ($chat, $text, $minutes, $sentAfter): ChatOutgoing {
            $reply = $this->chatFields()->newOutgoing(Uuid::v7(), $this->find($chat), $text, $this->at($minutes));
            if (null !== $sentAfter) {
                $reply->markSent($this->at($sentAfter));
            }
            $entityManager->persist($reply);

            return $reply;
        });
        $this->ids[$name] = $reply->getId()->toRfc4122();

        return $reply;
    }

    /** The chat as the entity manager holds it now. */
    protected function find(Chat $chat): Chat
    {
        $found = $this->chatEntityManager()->find(Chat::class, $chat->getId());
        self::assertInstanceOf(Chat::class, $found);

        return $found;
    }

    /** The Mac that relays Kim's WhatsApp went offline an hour ago. */
    protected function relayGoesOffline(): void
    {
        $this->connection()->executeStatement(
            'UPDATE chat_account SET relay_online = false, relay_offline_since = :since WHERE id = :id',
            ['since' => $this->at(60)->format('Y-m-d H:i:s'), 'id' => $this->kimsAccount->getId()->toRfc4122()],
        );
        static::getContainer()->get(EntityManagerInterface::class)->clear();
    }

    /**
     * A personal access token of $email with these scopes, made by our web app holding them.
     *
     * @param list<string> $scopes
     *
     * @return array<string, string>
     */
    protected function chatToken(string $email, array $scopes): array
    {
        return $this->personalAccessTokenHeaders($email, $scopes);
    }
}
