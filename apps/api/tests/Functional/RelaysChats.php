<?php

declare(strict_types=1);

namespace App\Tests\Functional;

use App\Chat\SweepChatRelaysHandler;
use Doctrine\ORM\EntityManagerInterface;
use Symfony\Bundle\FrameworkBundle\KernelBrowser;
use Symfony\Component\Uid\UuidV7;

/**
 * Kim's WhatsApp, connected by her desktop, and the calls its relay and her other devices make. Needs
 * {@see AuthenticatesUsers}.
 *
 * @property KernelBrowser $client
 */
trait RelaysChats
{
    protected const string MAC = '0193a1c2-7b1e-7c3a-9f00-1b2c3d4e5f60';
    protected const string OTHER_MAC = '0193a1c2-7b1e-7c3a-9f00-1b2c3d4e5f61';
    protected const string JID = '31612345678@s.whatsapp.net';
    protected const string OTHER_JID = '31687654321@s.whatsapp.net';
    protected const string GROUP_JID = '120363025246125486@g.us';

    /** @var array<string, string> Kim's desktop app, the relay */
    protected array $desktop;

    /** @var array<string, string> Kim's web app */
    protected array $web;

    protected string $accountId;

    /**
     * Kim and Lisa, and Kim's WhatsApp connected from her Mac.
     */
    protected function setUpRelay(): void
    {
        $this->bootstrapOAuthClients();
        $this->createUser('kim@example.test', 'Kim');
        $this->createUser('lisa@example.test', 'Lisa');
        $this->desktop = $this->userHeaders('kim@example.test', ['mail:read', 'mail:write', 'mail:send'], 'desktop');
        $this->web = $this->userHeaders('kim@example.test', ['mail:read', 'mail:write', 'mail:send']);
        $this->accountId = $this->connectWhatsApp($this->desktop, self::MAC);
    }

    /**
     * @param array<string, string> $headers
     */
    protected function connectWhatsApp(array $headers, string $deviceId): string
    {
        $this->client->jsonRequest('PUT', '/api/v1/chat-accounts/whatsapp', [
            'deviceId' => $deviceId,
            'deviceName' => 'Kim\'s MacBook Pro',
            'address' => '31698765432',
            'displayName' => 'Kim Visser',
        ], $headers);
        self::assertResponseStatusCodeSame(200);

        return $this->responseString('id');
    }

    /**
     * A relay call for Kim's account: `status`, `messages`, `outgoing/claim` or `outgoing/<id>/result`.
     *
     * @param array<string, mixed>       $body     without `deviceId`, which is the Mac's unless given
     * @param array<string, string>|null $headers  Kim's desktop unless given
     */
    protected function relay(string $path, array $body = [], ?array $headers = null, ?string $accountId = null): void
    {
        $this->client->jsonRequest('POST', \sprintf('/api/v1/chat-accounts/%s/relay/%s', $accountId ?? $this->accountId, $path), $body + ['deviceId' => self::MAC], $headers ?? $this->desktop);
    }

    /**
     * The relay's result for a reply, for the claim the reply holds now unless the body names one.
     *
     * @param array<string, mixed>       $body
     * @param array<string, string>|null $headers
     */
    protected function report(string $replyId, array $body, ?array $headers = null): void
    {
        $this->relay('outgoing/'.$replyId.'/result', $body + ['claimedAt' => $this->claimOf($replyId)], $headers);
    }

    /** When the reply was claimed, as the claim answered it; a time of no claim when nobody claimed it. */
    protected function claimOf(string $replyId): string
    {
        $at = $this->connection()->fetchOne('SELECT claimed_at FROM chat_outgoing WHERE id = :id', ['id' => $replyId]);

        return \is_string($at) ? new \DateTimeImmutable($at)->format(\DATE_ATOM) : '2026-11-12T10:00:00+00:00';
    }

    /**
     * Stores messages through the relay and returns its answer.
     *
     * @param list<array<string, mixed>> $messages
     * @param list<array<string, mixed>> $chats
     *
     * @return array<mixed>
     */
    protected function relayMessages(array $messages, array $chats = [['jid' => self::JID, 'name' => 'Bram Visser', 'kind' => 'direct']], bool $firstImport = false): array
    {
        $this->relay('messages', ['firstImport' => $firstImport, 'chats' => $chats, 'messages' => $messages]);
        self::assertResponseStatusCodeSame(200);

        return $this->decodedResponse();
    }

    /**
     * A message of the bridge's store, as the relay sends it.
     *
     * @param array<string, mixed> $extra
     *
     * @return array<string, mixed>
     */
    protected static function waMessage(string $waId, string $text, string $sentAt = '2026-11-12T09:14:00+00:00', array $extra = []): array
    {
        return $extra + ['chatJid' => self::JID, 'waId' => $waId, 'fromMe' => false, 'sender' => null, 'text' => $text, 'sentAt' => $sentAt, 'media' => null];
    }

    /** The id of Kim's chat with this JID, as the delta lists it. */
    protected function chatId(string $jid = self::JID): string
    {
        foreach ($this->delta(0)['chats'] as $chat) {
            if ($jid === ($chat['jid'] ?? null)) {
                self::assertIsString($chat['id'] ?? null);

                return $chat['id'];
            }
        }
        self::fail('No chat '.$jid.' in the delta.');
    }

    /**
     * Queues a reply from Kim's web app and returns the answer.
     *
     * @param array<string, string>|null $headers
     *
     * @return array<mixed>
     */
    protected function queueReply(string $chatId, string $text, ?string $id = null, ?array $headers = null): array
    {
        $this->client->jsonRequest('POST', '/api/v1/chats/'.$chatId.'/outgoing', ['id' => $id ?? self::newReplyId(), 'text' => $text], $headers ?? $this->web);

        return $this->decodedResponse();
    }

    protected static function newReplyId(): string
    {
        return new UuidV7()->toRfc4122();
    }

    /**
     * Kim's delta from $since, as her web app reads it.
     *
     * @param array<string, string>|null $headers
     *
     * @return array{cursor: int, chatAccounts: list<array<string, mixed>>, chats: list<array<string, mixed>>, chatMessages: list<array<string, mixed>>, chatOutgoing: list<array<string, mixed>>, deleted: list<array{type: string, id: string}>}
     */
    protected function delta(int $since, ?array $headers = null): array
    {
        $this->client->request('GET', \sprintf('/api/v1/sync/changes?since=%d&limit=2000', $since), server: $headers ?? $this->web);
        self::assertResponseIsSuccessful();

        /** @var array{cursor: int, chatAccounts: list<array<string, mixed>>, chats: list<array<string, mixed>>, chatMessages: list<array<string, mixed>>, chatOutgoing: list<array<string, mixed>>, deleted: list<array{type: string, id: string}>} */
        return $this->decodedResponse();
    }

    /** $actual is a time that names the same instant as $expected. */
    protected static function assertInstant(string $expected, mixed $actual, string $message = ''): void
    {
        self::assertIsString($actual, $message);
        self::assertSame(new \DateTimeImmutable($expected)->getTimestamp(), new \DateTimeImmutable($actual)->getTimestamp(), $message);
    }

    /** The change number of Kim's last change. */
    protected function kimsChangeSeq(): int
    {
        $seq = $this->connection()->fetchOne("SELECT change_seq FROM app_user WHERE email = 'kim@example.test'");
        self::assertIsInt($seq);

        return $seq;
    }

    /** @return array{offline: int, unconfirmed: int} */
    protected function sweep(): array
    {
        $result = static::getContainer()->get(SweepChatRelaysHandler::class)->sweep();
        static::getContainer()->get(EntityManagerInterface::class)->clear();

        return $result;
    }

    /**
     * The property paths of the violations of the last (422) response.
     *
     * @return array<mixed>
     */
    protected function violationPaths(): array
    {
        $violations = $this->decodedResponse()['violations'] ?? null;
        self::assertIsArray($violations);

        return array_column($violations, 'propertyPath');
    }
}
