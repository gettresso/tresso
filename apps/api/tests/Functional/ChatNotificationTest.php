<?php

declare(strict_types=1);

namespace App\Tests\Functional;

use App\Chat\ChatNotifier;
use App\Chat\NotifyChatMessage;
use App\Tests\Support\MockHttpRouter;
use Symfony\Component\Messenger\Envelope;
use Symfony\Component\Messenger\Stamp\DelayStamp;
use Symfony\Component\Messenger\Transport\InMemory\InMemoryTransport;

/**
 * A push to the phone for a new WhatsApp message, with Notify me on: one per chat, the chat's name only, never the text
 * or a number, and nothing for the history of a first import, the user's own messages, old messages, a chat read on
 * another device meanwhile, or with Notify me off.
 */
final class ChatNotificationTest extends DatabaseTestCase
{
    use AuthenticatesUsers;
    use RelaysChats;

    private const string EXPO_SEND = 'https://exp.host/--/api/v2/push/send';
    private const string GROUP = 'Family';

    protected function setUp(): void
    {
        parent::setUp();
        $this->setUpRelay();
        $this->http()->respond(self::EXPO_SEND, json_encode(['data' => [['status' => 'ok', 'id' => 'ticket-1']]], \JSON_THROW_ON_ERROR));
        $settings = $this->userHeaders('kim@example.test', ['settings:read', 'settings:write']);
        $this->client->jsonRequest('POST', '/api/v1/notification-devices', ['kind' => 'expo', 'endpoint' => 'ExponentPushToken[abc123]', 'name' => 'Phone'], $settings);
        self::assertResponseIsSuccessful();
    }

    public function testANewMessagePushesTheChatsNameOnlyToThePhone(): void
    {
        $this->notifyMe(true);

        $queued = $this->relayed([
            self::waMessage('M1', 'The door code is 4711', self::ago(3)),
            self::waMessage('M2', 'Can you bring the drill on Saturday?', self::ago(1)),
        ]);
        self::assertCount(1, $queued, 'One push for the chat, for its newest message.');
        $delay = $queued[0]->last(DelayStamp::class);
        self::assertInstanceOf(DelayStamp::class, $delay);
        self::assertSame(ChatNotifier::COALESCE_MS, $delay->getDelay(), 'It waits a little for more messages of the chat.');
        $this->deliver($queued);

        $pushes = $this->expoBodies();
        self::assertCount(1, $pushes);
        $chatId = $this->chatId();
        self::assertSame('WhatsApp', $pushes[0]['title']);
        self::assertSame('Bram Visser', $pushes[0]['body']);
        self::assertSame('whatsapp', $pushes[0]['channelId']);
        self::assertSame('default', $pushes[0]['sound']);
        self::assertSame('whatsapp', $pushes[0]['data']['kind'] ?? null);
        self::assertSame('/chats/'.$chatId, $pushes[0]['data']['path'] ?? null, 'A tap opens the chat.');
        self::assertSame($chatId, $pushes[0]['data']['chatId'] ?? null);
        $sent = $this->http()->requestsTo(self::EXPO_SEND)[0]['body'];
        foreach (['door code', '4711', 'drill', '31612345678', 'whatsapp.net'] as $secret) {
            self::assertStringNotContainsString($secret, $sent, 'Nothing of the message or the number leaves in the push.');
        }
    }

    public function testAChatWithoutANameIsNotNamedByItsNumber(): void
    {
        $this->notifyMe(true);

        $this->deliver($this->relayed([self::waMessage('M1', 'Hello', self::ago(1))], [['jid' => self::JID, 'name' => null, 'kind' => 'direct']]));

        $pushes = $this->expoBodies();
        self::assertCount(1, $pushes);
        self::assertSame(ChatNotifier::NO_NAME, $pushes[0]['body']);
        self::assertStringNotContainsString('31612345678', $this->http()->requestsTo(self::EXPO_SEND)[0]['body']);
    }

    public function testOnePushPerChatAndBurst(): void
    {
        $this->notifyMe(true);

        $first = $this->relayed(
            [
                self::waMessage('M1', 'Hi', self::ago(4)),
                self::waMessage('G1', 'Dinner at 18:00?', self::ago(3), ['chatJid' => self::GROUP_JID, 'sender' => ['id' => '31611111111@s.whatsapp.net', 'name' => 'Mom']]),
            ],
            [['jid' => self::JID, 'name' => 'Bram Visser', 'kind' => 'direct'], ['jid' => self::GROUP_JID, 'name' => self::GROUP, 'kind' => 'group']],
        );
        self::assertCount(2, $first, 'One per chat of the batch.');
        // Bram writes again before the first push went: that one is left to the newer message.
        $second = $this->relayed([self::waMessage('M2', 'Are you there?', self::ago(1))]);
        self::assertCount(1, $second);
        $this->deliver([...$first, ...$second]);

        $bodies = array_map(static fn (array $push): string => $push['body'], $this->expoBodies());
        sort($bodies);
        self::assertSame(['Bram Visser', self::GROUP], $bodies);
    }

    public function testADeliveryRepeatedNeverNotifiesTwice(): void
    {
        $this->notifyMe(true);
        $queued = $this->relayed([self::waMessage('M1', 'Hi', self::ago(1))]);

        $this->deliver($queued);
        $this->deliver($queued);

        self::assertCount(1, $this->expoBodies());
    }

    public function testNothingWithNotifyMeOff(): void
    {
        self::assertSame([], $this->relayed([self::waMessage('M1', 'Hi', self::ago(1))]));
    }

    public function testNothingOnceNotifyMeWentOffBeforeTheDelivery(): void
    {
        $this->notifyMe(true);
        $queued = $this->relayed([self::waMessage('M1', 'Hi', self::ago(1))]);
        self::assertCount(1, $queued);
        $this->notifyMe(false);

        $this->deliver($queued);

        self::assertSame([], $this->expoBodies());
    }

    public function testNothingForTheHistoryOfAFirstImport(): void
    {
        $this->notifyMe(true);

        self::assertSame([], $this->relayed([self::waMessage('M1', 'Hi', self::ago(1))], firstImport: true));
    }

    public function testNothingForOwnOrOldMessages(): void
    {
        $this->notifyMe(true);

        $queued = $this->relayed([
            self::waMessage('M1', 'Typed on my phone', self::ago(1), ['fromMe' => true]),
            self::waMessage('M2', 'From an hour ago', self::ago(60), ['chatJid' => self::OTHER_JID]),
        ], [['jid' => self::JID, 'name' => 'Bram Visser', 'kind' => 'direct'], ['jid' => self::OTHER_JID, 'name' => 'Lisa', 'kind' => 'direct']]);

        self::assertSame([], $queued);
    }

    public function testNothingForAChatReadOnAnotherDeviceMeanwhile(): void
    {
        $this->notifyMe(true);
        $sentAt = self::ago(1);
        $queued = $this->relayed([self::waMessage('M1', 'Hi', $sentAt)]);
        self::assertCount(1, $queued);

        $this->client->request('PATCH', '/api/v1/chats/'.$this->chatId(), server: $this->web + ['CONTENT_TYPE' => 'application/merge-patch+json'], content: json_encode(['readThrough' => $sentAt], \JSON_THROW_ON_ERROR));
        self::assertResponseIsSuccessful();
        $this->deliver($queued);

        self::assertSame([], $this->expoBodies());
    }

    private function notifyMe(bool $on): void
    {
        $this->client->request('PATCH', '/api/v1/chat-accounts/'.$this->accountId, server: $this->web + ['CONTENT_TYPE' => 'application/merge-patch+json'], content: json_encode(['notify' => $on], \JSON_THROW_ON_ERROR));
        self::assertResponseIsSuccessful();
    }

    /** A time this many minutes ago, as the relay sends it. */
    private static function ago(int $minutes): string
    {
        return new \DateTimeImmutable(\sprintf('-%d minutes', $minutes))->format(\DATE_ATOM);
    }

    /**
     * Stores messages through the relay and returns the pushes that call queued (read at once: the next request resets
     * the in-memory queue).
     *
     * @param list<array<string, mixed>> $messages
     * @param list<array<string, mixed>> $chats
     *
     * @return list<Envelope>
     */
    private function relayed(array $messages, array $chats = [['jid' => self::JID, 'name' => 'Bram Visser', 'kind' => 'direct']], bool $firstImport = false): array
    {
        $this->pushTransport()->reset();
        $this->relayMessages($messages, $chats, $firstImport);

        return array_values(array_filter([...$this->pushTransport()->getSent()], static fn (Envelope $envelope): bool => $envelope->getMessage() instanceof NotifyChatMessage));
    }

    /**
     * Delivers queued pushes, the way the push worker does once their delay passed.
     *
     * @param list<Envelope> $envelopes
     */
    private function deliver(array $envelopes): void
    {
        foreach ($envelopes as $envelope) {
            $message = $envelope->getMessage();
            self::assertInstanceOf(NotifyChatMessage::class, $message);
            $this->notifier()->onNotify($message);
        }
    }

    private function notifier(): ChatNotifier
    {
        return static::getContainer()->get(ChatNotifier::class);
    }

    private function pushTransport(): InMemoryTransport
    {
        $transport = static::getContainer()->get('messenger.transport.push');
        self::assertInstanceOf(InMemoryTransport::class, $transport);

        return $transport;
    }

    /**
     * @return list<array{title: string, body: string, sound: ?string, channelId: string, data: array<string, mixed>}>
     */
    private function expoBodies(): array
    {
        $bodies = [];
        foreach ($this->http()->requestsTo(self::EXPO_SEND) as $call) {
            /** @var array{title: string, body: string, sound: ?string, channelId: string, data: array<string, mixed>} $body */
            $body = json_decode($call['body'], true, flags: \JSON_THROW_ON_ERROR);
            $bodies[] = $body;
        }

        return $bodies;
    }

    private function http(): MockHttpRouter
    {
        return static::getContainer()->get(MockHttpRouter::class);
    }
}
