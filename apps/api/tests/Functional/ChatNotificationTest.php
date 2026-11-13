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

    /** @var array<string, string> Kim's settings, from her web app */
    private array $settings;

    protected function setUp(): void
    {
        parent::setUp();
        $this->setUpRelay();
        $this->http()->respond(self::EXPO_SEND, json_encode(['data' => [['status' => 'ok', 'id' => 'ticket-1']]], \JSON_THROW_ON_ERROR));
        $this->settings = $this->userHeaders('kim@example.test', ['settings:read', 'settings:write']);
        $this->client->jsonRequest('POST', '/api/v1/notification-devices', ['kind' => 'expo', 'endpoint' => 'ExponentPushToken[abc123]', 'name' => 'Phone'], $this->settings);
        self::assertResponseIsSuccessful();
    }

    public function testANewMessagePushesTheChatsNameOnlyToThePhone(): void
    {
        $this->notifyMe(true);

        $queued = $this->relayed([
            self::waMessage('M1', 'The door code is 4711', self::ago(180)),
            self::waMessage('M2', 'Can you bring the drill on Saturday?', self::ago(60)),
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

        $this->deliver($this->relayed([self::waMessage('M1', 'Hello', self::ago(60))], [['jid' => self::JID, 'name' => null, 'kind' => 'direct']]));

        $pushes = $this->expoBodies();
        self::assertCount(1, $pushes);
        self::assertSame(ChatNotifier::NO_NAME, $pushes[0]['body']);
        self::assertStringNotContainsString('31612345678', $this->http()->requestsTo(self::EXPO_SEND)[0]['body']);
    }

    public function testAChatNamedByANumberIsNotNamedInThePush(): void
    {
        $this->notifyMe(true);

        $this->deliver($this->relayed(
            [self::waMessage('M1', 'Hello', self::ago(60)), self::waMessage('L1', 'Hi there', self::ago(60), ['chatJid' => self::OTHER_JID])],
            [['jid' => self::JID, 'name' => '31612345678', 'kind' => 'direct'], ['jid' => self::OTHER_JID, 'name' => '+31 6 12345678', 'kind' => 'direct']],
        ));

        self::assertSame([ChatNotifier::NO_NAME, ChatNotifier::NO_NAME], array_map(static fn (array $push): string => $push['body'], $this->expoBodies()));
        foreach ($this->http()->requestsTo(self::EXPO_SEND) as $call) {
            self::assertStringNotContainsString('12345678', $call['body'], 'No number leaves in a push.');
        }
    }

    public function testANameIsKeptAndANumberIsNot(): void
    {
        self::assertSame('Bram Visser', ChatNotifier::bodyFor(' Bram Visser '));
        self::assertSame('Room 101', ChatNotifier::bodyFor('Room 101'));
        self::assertSame(ChatNotifier::NO_NAME, ChatNotifier::bodyFor('31612345678'));
        self::assertSame(ChatNotifier::NO_NAME, ChatNotifier::bodyFor('+31 6 12345678'));
        self::assertSame(ChatNotifier::NO_NAME, ChatNotifier::bodyFor('(020) 123-4567'));
        self::assertSame(ChatNotifier::NO_NAME, ChatNotifier::bodyFor(null));
    }

    public function testABurstOfOneChatPushesOnce(): void
    {
        $this->notifyMe(true);

        $first = $this->relayed(
            [
                self::waMessage('M1', 'Hi', self::ago(30)),
                self::waMessage('G1', 'Dinner at 18:00?', self::ago(25), ['chatJid' => self::GROUP_JID, 'sender' => ['id' => '31611111111@s.whatsapp.net', 'name' => 'Mom']]),
            ],
            [['jid' => self::JID, 'name' => 'Bram Visser', 'kind' => 'direct'], ['jid' => self::GROUP_JID, 'name' => self::GROUP, 'kind' => 'group']],
        );
        self::assertCount(2, $first, 'One per chat of the batch.');
        // Bram writes again before the first push went: that one is left to the newer message.
        $second = $this->relayed([self::waMessage('M2', 'Are you there?', self::ago(10))]);
        self::assertCount(1, $second);
        $this->deliver([...$first, ...$second]);

        $pushes = $this->expoBodies();
        $bodies = array_map(static fn (array $push): string => $push['body'], $pushes);
        sort($bodies);
        self::assertSame(['Bram Visser', self::GROUP], $bodies);
        $bram = array_values(array_filter($pushes, static fn (array $push): bool => 'Bram Visser' === $push['body']));
        self::assertSame($this->messageId('M2'), $bram[0]['data']['id'] ?? null, 'The newest message pushes.');
    }

    public function testAChatThatKeepsGettingMessagesIsPushedWithinAMinute(): void
    {
        $this->notifyMe(true);

        // Bram has been writing for a minute and a half; the push of his first message does not wait for the newest.
        $first = $this->relayed([self::waMessage('M1', 'Hi', self::ago(90))]);
        $second = $this->relayed([self::waMessage('M2', 'Still there?', self::ago(5))]);
        $this->deliver($first);

        $pushes = $this->expoBodies();
        self::assertCount(1, $pushes);
        self::assertSame($this->messageId('M1'), $pushes[0]['data']['id'] ?? null);

        $this->deliver($second);
        self::assertCount(1, $this->expoBodies(), 'A message the push just told of is not pushed again.');
    }

    public function testTwoMessagesOfTheSameSecondInTwoBatchesPushOnce(): void
    {
        $this->notifyMe(true);
        $at = self::ago(20);

        $first = $this->relayed([self::waMessage('M1', 'Hi', $at)]);
        $second = $this->relayed([self::waMessage('M2', 'Hello', $at)]);
        $this->deliver([...$first, ...$second]);

        $pushes = $this->expoBodies();
        self::assertCount(1, $pushes);
        $ids = [$this->messageId('M1'), $this->messageId('M2')];
        sort($ids);
        self::assertSame($ids[1], $pushes[0]['data']['id'] ?? null, 'The later id of the second wins.');
    }

    public function testADeliveryRepeatedNeverNotifiesTwice(): void
    {
        $this->notifyMe(true);
        $queued = $this->relayed([self::waMessage('M1', 'Hi', self::ago(60))]);

        $this->deliver($queued);
        $this->deliver($queued);

        self::assertCount(1, $this->expoBodies());
    }

    public function testNothingWithNotifyMeOff(): void
    {
        self::assertSame([], $this->relayed([self::waMessage('M1', 'Hi', self::ago(60))]));
    }

    public function testNothingOnceNotifyMeWentOffBeforeTheDelivery(): void
    {
        $this->notifyMe(true);
        $queued = $this->relayed([self::waMessage('M1', 'Hi', self::ago(60))]);
        self::assertCount(1, $queued);
        $this->notifyMe(false);

        $this->deliver($queued);

        self::assertSame([], $this->expoBodies());
    }

    public function testNothingForTheHistoryOfAFirstImport(): void
    {
        $this->notifyMe(true);

        self::assertSame([], $this->relayed([self::waMessage('M1', 'Hi', self::ago(60))], firstImport: true));
    }

    public function testAFirstImportFlagAfterTheHistoryWasImportedIsNotHonoured(): void
    {
        $this->notifyMe(true);
        self::assertSame([], $this->relayed([self::waMessage('M1', 'Hi', self::ago(120))], firstImport: true));
        self::assertCount(1, $this->relayed([self::waMessage('M2', 'Hello', self::ago(90))]), 'The history import ended with this batch.');

        self::assertCount(1, $this->relayed([self::waMessage('M3', 'Are you there?', self::ago(60))], firstImport: true), 'A relay that keeps saying firstImport still pushes.');
    }

    public function testNothingForOwnOrOldMessages(): void
    {
        $this->notifyMe(true);

        $queued = $this->relayed([
            self::waMessage('M1', 'Typed on my phone', self::ago(60), ['fromMe' => true]),
            self::waMessage('M2', 'From an hour ago', self::ago(3600), ['chatJid' => self::OTHER_JID]),
        ], [['jid' => self::JID, 'name' => 'Bram Visser', 'kind' => 'direct'], ['jid' => self::OTHER_JID, 'name' => 'Lisa', 'kind' => 'direct']]);

        self::assertSame([], $queued);
    }

    public function testNothingForAChatReadOnAnotherDeviceMeanwhile(): void
    {
        $this->notifyMe(true);
        $sentAt = self::ago(60);
        $queued = $this->relayed([self::waMessage('M1', 'Hi', $sentAt)]);
        self::assertCount(1, $queued);

        $this->client->request('PATCH', '/api/v1/chats/'.$this->chatId(), server: $this->web + ['CONTENT_TYPE' => 'application/merge-patch+json'], content: json_encode(['readThrough' => $sentAt], \JSON_THROW_ON_ERROR));
        self::assertResponseIsSuccessful();
        $this->deliver($queued);

        self::assertSame([], $this->expoBodies());
    }

    public function testNothingForAChatLeftOutMeanwhile(): void
    {
        $this->notifyMe(true);
        $queued = $this->relayed([self::waMessage('M1', 'Hi', self::ago(60))]);
        self::assertCount(1, $queued);

        $this->client->request('PATCH', '/api/v1/chats/'.$this->chatId(), server: $this->web + ['CONTENT_TYPE' => 'application/merge-patch+json'], content: json_encode(['leftOut' => true], \JSON_THROW_ON_ERROR));
        self::assertResponseIsSuccessful();
        $this->deliver($queued);

        self::assertSame([], $this->expoBodies());
    }

    public function testNothingForAMessageThatGrewStaleBeforeTheDelivery(): void
    {
        $this->notifyMe(true);
        $queued = $this->relayed([self::waMessage('M1', 'Hi', self::ago(60))]);
        $message = $queued[0]->getMessage();
        self::assertInstanceOf(NotifyChatMessage::class, $message);

        $this->notifier()->deliver($message->messageId, new \DateTimeImmutable('+20 minutes'));

        self::assertSame([], $this->expoBodies());
    }

    public function testQuietHoursMakeItSilent(): void
    {
        $this->notifyMe(true);
        $now = new \DateTimeImmutable('now', new \DateTimeZone('UTC'));
        $this->client->request('PATCH', '/api/v1/notification-settings', server: $this->settings + ['CONTENT_TYPE' => 'application/merge-patch+json'], content: json_encode(
            ['timeZone' => 'UTC', 'quietHoursEnabled' => true, 'quietDays' => [1, 2, 3, 4, 5, 6, 7], 'quietStart' => $now->modify('-1 hour')->format('H:i'), 'quietEnd' => $now->modify('+1 hour')->format('H:i')],
            \JSON_THROW_ON_ERROR,
        ));
        self::assertResponseIsSuccessful();

        $this->deliver($this->relayed([self::waMessage('M1', 'Hi', self::ago(60))]));

        $pushes = $this->expoBodies();
        self::assertCount(1, $pushes);
        self::assertSame('whatsapp_silent', $pushes[0]['channelId']);
        self::assertNull($pushes[0]['sound']);
    }

    private function notifyMe(bool $on): void
    {
        $this->client->request('PATCH', '/api/v1/chat-accounts/'.$this->accountId, server: $this->web + ['CONTENT_TYPE' => 'application/merge-patch+json'], content: json_encode(['notify' => $on], \JSON_THROW_ON_ERROR));
        self::assertResponseIsSuccessful();
    }

    /** A time this many seconds ago, as the relay sends it. */
    private static function ago(int $seconds): string
    {
        return new \DateTimeImmutable(\sprintf('-%d seconds', $seconds))->format(\DATE_ATOM);
    }

    /** The id of Kim's message with this WhatsApp id, as the delta lists it. */
    private function messageId(string $waId): string
    {
        foreach ($this->delta(0)['chatMessages'] as $message) {
            if ($waId === ($message['waId'] ?? null)) {
                self::assertIsString($message['id'] ?? null);

                return $message['id'];
            }
        }
        self::fail('No message '.$waId.' in the delta.');
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
