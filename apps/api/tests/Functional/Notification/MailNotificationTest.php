<?php

declare(strict_types=1);

namespace App\Tests\Functional\Notification;

use App\Batch\ReleaseBatchHandler;
use App\Batch\SweepBatches;
use App\Classification\MailClassification;
use App\Entity\Category;
use App\Entity\Message;
use App\Entity\User;
use App\Enum\Verdict;
use App\Notification\MailNotificationRetention;
use App\Notification\MailNotifier;
use App\Notification\NotificationHandlers;
use App\Notification\PlanCalendarObject;
use App\Notification\SendMailNotification;
use App\Repository\UserRepository;
use App\Storage\Reencryption;
use App\Tests\Functional\AuthenticatesUsers;
use App\Tests\Functional\Calendar\CalendarTestHelpers;
use App\Tests\Functional\DatabaseTestCase;
use App\Tests\Functional\StoresMail;
use App\Tests\Support\MockHttpRouter;
use Doctrine\ORM\EntityManagerInterface;
use Symfony\Component\Messenger\MessageBusInterface;
use Symfony\Component\Messenger\Stamp\DelayStamp;
use Symfony\Component\Messenger\Stamp\ReceivedStamp;
use Symfony\Component\Messenger\Transport\InMemory\InMemoryTransport;
use Symfony\Component\Uid\Uuid;

/**
 * Push for new mail end to end: ingested, classified `do`, and delivered once to the phone and the browser, with the
 * conversation to open; shown by the desktop app from the delta.
 */
final class MailNotificationTest extends DatabaseTestCase
{
    use AuthenticatesUsers;
    use StoresMail;
    use CalendarTestHelpers;

    private const string ME = 'kim@company.example';
    private const string PUSH_ENDPOINT = 'https://push.example.test/subscriptions/1';
    private const string P256DH = 'BCVxsr7N_eNgVRqvHtD0zTZsEc6-VV-JvLexhqUzORcxaOzi6-AYWXvTBHm4bjyPjs7Vd8pZGH6SRpkNtoIAiw4';
    private const string AUTH = 'BTBZMqHH6r4Tts7J_aSIgg';
    private const string EXPO_SEND = 'https://exp.host/--/api/v2/push/send';

    private string $accountId;

    /** @var array<string, string> */
    private array $worker;

    /** @var array<string, string> */
    private array $kim;

    protected function setUp(): void
    {
        parent::setUp();
        $this->bootstrapOAuthClients();
        $this->createUser('kim@example.test', 'Kim');
        $this->kim = $this->userHeaders('kim@example.test', ['mail:read', 'mail:write', 'calendar:read', 'calendar:write', 'settings:read', 'settings:write']);

        $this->client->jsonRequest('POST', '/api/v1/mail-accounts', [
            'emailAddress' => self::ME,
            'displayName' => 'Work',
            'username' => self::ME,
            'password' => 'app-password-1',
            'imap' => ['host' => 'imap.company.example', 'port' => 993, 'security' => 'tls'],
            'smtp' => ['host' => 'smtp.company.example', 'port' => 465, 'security' => 'tls'],
        ], $this->kim);
        $this->accountId = $this->responseString('id');

        $this->worker = $this->workerHeaders('sync:lease sync:ingest');
        $this->client->jsonRequest('POST', '/internal/sync/leases', ['workerId' => 'w1'], $this->worker);
        $this->ingest('folders', ['folders' => [
            ['remoteName' => 'INBOX', 'displayName' => 'Inbox', 'role' => 'inbox', 'uidValidity' => 1],
            ['remoteName' => 'Archive', 'displayName' => 'Archive', 'role' => 'archive', 'uidValidity' => 1],
        ]]);

        $this->http()->respond(self::PUSH_ENDPOINT, '', 201);
        $this->http()->respond(self::EXPO_SEND, json_encode(['data' => [['status' => 'ok', 'id' => 'ticket-1']]], \JSON_THROW_ON_ERROR));
        foreach ([
            ['kind' => 'web_push', 'endpoint' => self::PUSH_ENDPOINT, 'publicKey' => self::P256DH, 'authSecret' => self::AUTH, 'name' => 'Firefox'],
            ['kind' => 'expo', 'endpoint' => 'ExponentPushToken[abc123]', 'name' => 'Phone'],
        ] as $device) {
            $this->client->jsonRequest('POST', '/api/v1/notification-devices', $device, $this->kim);
            self::assertResponseIsSuccessful();
        }
    }

    public function testNewMailThatNeedsTheUserReachesThePhoneAndBrowserOnceWithItsConversation(): void
    {
        $this->ingest('messages', ['folder' => 'INBOX', 'messages' => [$this->message('1', 'Budget review', ['snippet' => 'Can you check the numbers?'])]]);
        $this->classifyAndSend();

        $page = $this->changes();
        $thread = $page['threads'][0];
        self::assertSame('do', $thread['verdict']);
        $expo = $this->expoBodies();
        self::assertCount(1, $expo);
        self::assertSame('Anna de Vries', $expo[0]['title']);
        self::assertSame("Budget review\nCan you check the numbers?", $expo[0]['body']);
        self::assertSame('mail', $expo[0]['channelId']);
        self::assertSame('default', $expo[0]['sound']);
        self::assertSame('mail', $expo[0]['data']['kind']);
        self::assertSame('/thread/'.$thread['id'], $expo[0]['data']['path'], 'A tap opens the conversation.');
        self::assertSame($thread['id'], $expo[0]['data']['threadId']);
        self::assertSame($this->kimsId()->toRfc4122(), $expo[0]['data']['userId'], 'A browser shows it only for the user who turned notifications on there.');
        self::assertCount(1, $this->http()->requestsTo(self::PUSH_ENDPOINT), 'The browser gets it by web push.');

        $notifications = $page['mailNotifications'];
        self::assertCount(1, $notifications, 'The desktop app sees it in the delta.');
        self::assertSame($thread['id'], $notifications[0]['threadId']);
        self::assertSame(['phone', 'desktop'], $notifications[0]['channels']);
        self::assertFalse($notifications[0]['silent']);
        self::assertNotNull($notifications[0]['deliveredAt']);
    }

    public function testWhatANotificationSaysIsSealedInTheDatabase(): void
    {
        $this->ingest('messages', ['folder' => 'INBOX', 'messages' => [$this->message('1', 'Budget review', ['snippet' => 'Can you check the numbers?'])]]);
        $this->classifyAndSend();

        $row = $this->connection()->fetchAssociative('SELECT title, body, sealed_body FROM mail_notification');
        self::assertIsArray($row);
        self::assertSame('', $row['body']);
        self::assertIsString($row['sealed_body']);
        self::assertStringStartsWith('f1.1.', $row['sealed_body']);
        self::assertStringNotContainsString('numbers', (string) base64_decode(explode('.', $row['sealed_body'], 3)[2], true));
        self::assertSame("Budget review\nCan you check the numbers?", $this->changes()['mailNotifications'][0]['body'], 'Clients still get what it says.');
    }

    public function testWhatOldNotificationsSaidIsClearedOnceClientsNoLongerGetThem(): void
    {
        $this->ingest('messages', ['folder' => 'INBOX', 'messages' => [
            $this->message('1', 'Budget review', ['snippet' => 'Can you check the numbers?']),
            $this->message('2', 'Offsite', ['snippet' => 'Where do we meet?']),
        ]]);
        $this->classifyAndSend();
        $this->connection()->executeStatement("UPDATE mail_notification SET delivered_at = NOW() - interval '8 days' WHERE message_id = (SELECT id FROM message WHERE subject = 'Budget review')");

        $cleared = static::getContainer()->get(MailNotificationRetention::class)->scrub(new \DateTimeImmutable());

        self::assertSame(1, $cleared);
        $rows = $this->connection()->fetchAllAssociative('SELECT m.subject, n.title, n.body, n.sealed_body FROM mail_notification n JOIN message m ON m.id = n.message_id ORDER BY m.subject');
        self::assertSame(['subject' => 'Budget review', 'title' => '', 'body' => '', 'sealed_body' => null], $rows[0]);
        self::assertSame('Anna de Vries', $rows[1]['title'], 'A notification clients still get keeps what it says.');
        self::assertNotNull($rows[1]['sealed_body']);
        self::assertSame(1, $this->countRows('SELECT COUNT(*) FROM mail_notification WHERE message_id = (SELECT id FROM message WHERE subject = :s)', ['s' => 'Budget review']), 'The row stays, so the mail never notifies again.');
    }

    public function testANotificationThatCanNoLongerBeDeliveredIsClearedButOneStillDueKeepsItsText(): void
    {
        $this->ingest('messages', ['folder' => 'INBOX', 'messages' => [
            $this->message('1', 'Budget review', ['snippet' => 'Can you check the numbers?']),
            $this->message('2', 'Offsite', ['snippet' => 'Where do we meet?']),
        ]]);
        $this->classifyAndSend();
        // Both still waiting: one whose time passed long ago (it would be dropped, never delivered), one held until later.
        $this->connection()->executeStatement("UPDATE mail_notification SET delivered_at = NULL, dropped_at = NULL, fire_at = NOW() - interval '8 days' WHERE message_id = (SELECT id FROM message WHERE subject = 'Budget review')");
        $this->connection()->executeStatement("UPDATE mail_notification SET delivered_at = NULL, dropped_at = NULL, fire_at = NOW() + interval '1 hour' WHERE message_id = (SELECT id FROM message WHERE subject = 'Offsite')");

        $cleared = static::getContainer()->get(MailNotificationRetention::class)->scrub(new \DateTimeImmutable());

        self::assertSame(1, $cleared);
        $rows = $this->connection()->fetchAllAssociative('SELECT m.subject, n.title, n.sealed_body FROM mail_notification n JOIN message m ON m.id = n.message_id ORDER BY m.subject');
        self::assertSame(['subject' => 'Budget review', 'title' => '', 'sealed_body' => null], $rows[0]);
        self::assertSame('Anna de Vries', $rows[1]['title'], 'A delivery still due keeps what it says.');
        self::assertNotNull($rows[1]['sealed_body']);
        self::assertLessThan(strtotime('+'.MailNotificationRetention::KEEP), strtotime('+'.MailNotifier::MAX_LATE), 'Cleared only once it can never be delivered.');
    }

    public function testNotificationTextFromBeforeEncryptionIsSealedByReencryption(): void
    {
        $this->ingest('messages', ['folder' => 'INBOX', 'messages' => [$this->message('1', 'Budget review', ['snippet' => 'Can you check the numbers?'])]]);
        $this->classifyAndSend();
        $this->connection()->executeStatement("UPDATE mail_notification SET body = 'Budget review', sealed_body = NULL");

        static::getContainer()->get(Reencryption::class)->run($this->kimsId(), 200, static function (): void {});

        $row = $this->connection()->fetchAssociative('SELECT body, sealed_body FROM mail_notification');
        self::assertIsArray($row);
        self::assertSame('', $row['body']);
        self::assertIsString($row['sealed_body']);
        self::assertStringStartsWith('f1.', $row['sealed_body']);
        self::assertSame('Budget review', $this->changes()['mailNotifications'][0]['body']);
    }

    public function testAMessageNotifiesOnlyOnce(): void
    {
        $this->ingest('messages', ['folder' => 'INBOX', 'messages' => [$this->message('1', 'Budget review')]]);
        $this->classifyAndSend();

        // Judged otherwise and then `do` again (a rule changed), delivered again by a retried message or the sweep.
        $this->connection()->executeStatement("UPDATE message SET verdict = 'know'");
        static::getContainer()->get(EntityManagerInterface::class)->clear();
        static::getContainer()->get(MailClassification::class)->reclassify($this->kimsId(), null);
        $this->sendQueued();
        $this->notifier()->deliver($this->onlyNotificationId(), new \DateTimeImmutable());
        $this->notifier()->sweep(new \DateTimeImmutable('+1 minute'));

        self::assertCount(1, $this->expoBodies());
        self::assertCount(1, $this->http()->requestsTo(self::PUSH_ENDPOINT));
        self::assertEquals(1, $this->connection()->fetchOne('SELECT COUNT(*) FROM mail_notification'));
    }

    public function testMailThatDoesNotNeedTheUserNowNeverNotifies(): void
    {
        $this->ingest('messages', ['folder' => 'INBOX', 'messages' => [
            $this->message('1', 'Weekly deals', ['from' => ['address' => 'newsletter@shop.example'], 'headers' => ['list-unsubscribe' => '<https://shop.example/u>']]),
            $this->message('2', 'Already read', ['flags' => ['seen' => true, 'flagged' => false, 'answered' => false, 'draft' => false]]),
            $this->message('3', 'From last year', ['receivedAt' => '2025-10-19T08:00:00+00:00']),
        ]]);
        $this->ingest('messages', ['folder' => 'Archive', 'messages' => [$this->message('1', 'Filed away')]]);
        $this->classifyAndSend();

        $verdicts = array_column($this->changes()['threads'], 'verdict', 'subject');
        self::assertSame(['know', 'do', 'do', 'do'], [$verdicts['Weekly deals'], $verdicts['Already read'], $verdicts['From last year'], $verdicts['Filed away']]);
        self::assertEquals(0, $this->connection()->fetchOne('SELECT COUNT(*) FROM mail_notification'), 'Know mail, read mail, old mail (an account being fetched) and mail outside the inbox.');
        self::assertSame([], $this->expoBodies());
    }

    public function testMailReadBeforeItsDeliveryIsDropped(): void
    {
        $this->ingest('messages', ['folder' => 'INBOX', 'messages' => [$this->message('1', 'Budget review')]]);
        $this->runClassification();
        // Read on another device before the push queue got to it.
        $this->ingest('changes', ['folder' => 'INBOX', 'flags' => [['remoteUid' => '1', 'flags' => ['seen' => true, 'flagged' => false, 'answered' => false, 'draft' => false]]]]);
        $this->notifier()->deliver($this->onlyNotificationId(), new \DateTimeImmutable());

        self::assertSame([], $this->expoBodies());
        self::assertSame([], $this->changes()['mailNotifications']);
        self::assertEquals(1, $this->connection()->fetchOne('SELECT COUNT(*) FROM mail_notification WHERE dropped_at IS NOT NULL AND delivered_at IS NULL'));
    }

    public function testTheUserChoosesTheChannelsForMail(): void
    {
        $this->patchSettings(['channelsByKind' => ['mail' => ['phone']]]);
        self::assertSame(['mail' => ['phone']], $this->getJson('/api/v1/notification-settings', $this->kim)['channelsByKind']);
        $this->ingest('messages', ['folder' => 'INBOX', 'messages' => [$this->message('1', 'Budget review')]]);
        $this->classifyAndSend();

        self::assertCount(1, $this->expoBodies());
        self::assertSame([], $this->http()->requestsTo(self::PUSH_ENDPOINT));
        self::assertSame(['phone'], $this->changes()['mailNotifications'][0]['channels'], 'The desktop app shows only what was sent to the desktop.');

        $this->patchSettings(['channelsByKind' => ['mail' => []]]);
        $this->ingest('messages', ['folder' => 'INBOX', 'messages' => [$this->message('2', 'Offsite plans')]]);
        $this->classifyAndSend();

        self::assertCount(1, $this->expoBodies(), 'No channel: no notification for mail.');
    }

    public function testQuietHoursDeliverMailSilently(): void
    {
        $now = new \DateTimeImmutable('now', new \DateTimeZone('UTC'));
        $this->patchSettings(['timeZone' => 'UTC', 'quietHoursEnabled' => true, 'quietDays' => [1, 2, 3, 4, 5, 6, 7], 'quietStart' => $now->modify('-1 hour')->format('H:i'), 'quietEnd' => $now->modify('+1 hour')->format('H:i')]);
        $this->ingest('messages', ['folder' => 'INBOX', 'messages' => [$this->message('1', 'Budget review')]]);
        $this->classifyAndSend();

        $expo = $this->expoBodies();
        self::assertCount(1, $expo);
        self::assertNull($expo[0]['sound']);
        self::assertSame('mail_silent', $expo[0]['channelId'], 'On Android the silent channel decides.');
        self::assertTrue($this->changes()['mailNotifications'][0]['silent']);
    }

    public function testAMeetingHoldsMailUntilItEnds(): void
    {
        $start = $this->minute(-10);
        $this->createEvent($start, ['summary' => 'Budget meeting', 'attendees' => [['address' => 'anna@partner.example', 'name' => 'Anna de Vries']], 'organizerMailAccountId' => $this->accountId]);
        $this->ingest('messages', ['folder' => 'INBOX', 'messages' => [$this->message('1', 'Budget review')]]);
        $this->classifyAndSend();

        self::assertSame([], $this->expoBodies(), 'Not while the user is in the meeting.');
        $end = $start->modify('+30 minutes');
        self::assertSame($end->format('Y-m-d H:i:s'), $this->connection()->fetchOne('SELECT fire_at FROM mail_notification'));
        $delayed = $this->pushTransport()->getSent();
        self::assertCount(1, $delayed);
        self::assertInstanceOf(SendMailNotification::class, $delayed[0]->getMessage());
        $delay = $delayed[0]->last(DelayStamp::class)?->getDelay() ?? 0;
        self::assertEqualsWithDelta(($end->getTimestamp() - time()) * 1000, $delay, 5000, 'It comes back when the meeting ends.');

        $this->notifier()->deliver($this->onlyNotificationId(), $end);

        self::assertCount(1, $this->expoBodies());
    }

    public function testAFocusBlockHoldsMailUntilItEnds(): void
    {
        $start = $this->minute(-10);
        $this->createEvent($start, ['summary' => 'Focus: budget']);
        $this->ingest('messages', ['folder' => 'INBOX', 'messages' => [$this->message('1', 'Budget review')]]);
        $this->classifyAndSend();

        self::assertSame([], $this->expoBodies());
        self::assertSame($start->modify('+30 minutes')->format('Y-m-d H:i:s'), $this->connection()->fetchOne('SELECT fire_at FROM mail_notification'));
    }

    public function testWithoutTheFocusHoldMailComesSilentlyWhileTheUserIsBusy(): void
    {
        $this->patchSettings(['holdDuringFocus' => false, 'focusDuringBusy' => true]);
        $this->createEvent($this->minute(-10), ['summary' => 'Focus: budget']);
        $this->ingest('messages', ['folder' => 'INBOX', 'messages' => [$this->message('1', 'Budget review')]]);
        $this->classifyAndSend();

        $expo = $this->expoBodies();
        self::assertCount(1, $expo);
        self::assertSame('mail_silent', $expo[0]['channelId']);
    }

    public function testAFailedSendIsTriedAgainBySweep(): void
    {
        $this->http()->respondOnce(self::PUSH_ENDPOINT, '', 500);
        $this->ingest('messages', ['folder' => 'INBOX', 'messages' => [$this->message('1', 'Budget review')]]);
        $this->classifyAndSend();
        self::assertSame(['failed', 'sent'], $this->connection()->fetchFirstColumn("SELECT status FROM notification_delivery WHERE delivery_key LIKE 'mail:%' ORDER BY status"));

        $this->connection()->executeStatement("UPDATE notification_delivery SET updated_at = updated_at - INTERVAL '5 minutes'");
        $this->notifier()->sweep(new \DateTimeImmutable());

        self::assertCount(2, $this->http()->requestsTo(self::PUSH_ENDPOINT));
        self::assertCount(1, $this->expoBodies(), 'What went out is never sent again.');
    }

    public function testASweepDeliversWhatALostMessageMissed(): void
    {
        $this->ingest('messages', ['folder' => 'INBOX', 'messages' => [$this->message('1', 'Budget review')]]);
        $this->runClassification();
        $this->pushTransport()->reset();

        $this->notifier()->sweep(new \DateTimeImmutable());

        self::assertCount(1, $this->expoBodies());
    }

    public function testMailToHandOverSaysSo(): void
    {
        $this->ingest('messages', ['folder' => 'INBOX', 'messages' => [$this->message('1', 'Weekly deals', ['from' => ['address' => 'newsletter@shop.example', 'name' => ''], 'headers' => ['list-unsubscribe' => '<https://shop.example/u>'], 'snippet' => ''])]]);
        $this->runClassification();
        $entityManager = static::getContainer()->get(EntityManagerInterface::class);
        $message = $entityManager->getRepository(Message::class)->findOneBy(['subject' => 'Weekly deals']) ?? self::fail('No message.');
        $category = $message->getCategory() ?? self::fail('Not classified.');
        self::assertInstanceOf(Category::class, $category);
        // As an AI classifier judges it: to hand over.
        $entityManager->wrapInTransaction(function () use ($message, $category): void {
            // Advertising waits for a batch; this one's has come.
            $message->release(new \DateTimeImmutable());
            $message->classify($category, Verdict::Delegate, new \DateTimeImmutable());
            $this->notifier()->consider($this->kim(), [$message], new \DateTimeImmutable());
        });
        $this->sendQueued();

        $expo = $this->expoBodies();
        self::assertCount(1, $expo);
        self::assertSame('newsletter@shop.example', $expo[0]['title'], 'Without a name, the address.');
        self::assertSame('To hand over: Weekly deals', $expo[0]['body']);
    }

    public function testMailReachesOnlyItsOwnersDevices(): void
    {
        $this->createUser('lisa@example.test', 'Lisa');
        $lisa = $this->userHeaders('lisa@example.test', ['settings:write']);
        $this->client->jsonRequest('POST', '/api/v1/notification-devices', ['kind' => 'expo', 'endpoint' => 'ExponentPushToken[lisa]', 'name' => 'Lisa phone'], $lisa);
        self::assertResponseIsSuccessful();

        $this->ingest('messages', ['folder' => 'INBOX', 'messages' => [$this->message('1', 'Budget review')]]);
        $this->classifyAndSend();

        $expo = $this->http()->requestsTo(self::EXPO_SEND);
        self::assertCount(1, $expo);
        $body = json_decode($expo[0]['body'], true, flags: \JSON_THROW_ON_ERROR);
        self::assertIsArray($body);
        self::assertSame('ExponentPushToken[abc123]', $body['to']);
    }

    public function testTheSameMailInTwoAccountsNotifiesOnce(): void
    {
        $home = $this->homeAccount();

        $both = $this->message('1', 'Budget review', ['messageId' => '<budget@partner.example>', 'to' => [['address' => self::ME], ['address' => 'kim@home.example']]]);
        $this->ingest('messages', ['folder' => 'INBOX', 'messages' => [$both]]);
        $this->client->jsonRequest('POST', '/internal/sync/accounts/'.$home.'/messages', ['workerId' => 'w1', 'folder' => 'INBOX', 'messages' => [$both]], $this->worker);
        self::assertResponseIsSuccessful();
        $this->classifyAndSend();

        self::assertSame(['do', 'do'], array_column($this->changes()['threads'], 'verdict'));
        self::assertCount(1, $this->expoBodies());
        self::assertEquals(1, $this->connection()->fetchOne('SELECT COUNT(*) FROM mail_notification WHERE dropped_at IS NOT NULL'), 'The copy never notifies later either.');
    }

    public function testTheSameMailReachingAnotherAccountLaterNotifiesOnce(): void
    {
        $home = $this->homeAccount();
        $both = $this->message('1', 'Budget review', ['messageId' => '<budget@partner.example>', 'to' => [['address' => self::ME], ['address' => 'kim@home.example']]]);
        $this->ingest('messages', ['folder' => 'INBOX', 'messages' => [$both]]);
        $this->classifyAndSend();
        self::assertCount(1, $this->expoBodies());

        // The other account syncs a few minutes later: a classification run of its own.
        $this->client->jsonRequest('POST', '/internal/sync/accounts/'.$home.'/messages', ['workerId' => 'w1', 'folder' => 'INBOX', 'messages' => [$both]], $this->worker);
        self::assertResponseIsSuccessful();
        $this->classifyAndSend();

        self::assertSame(['do', 'do'], array_column($this->changes()['threads'], 'verdict'));
        self::assertCount(1, $this->expoBodies());
        self::assertEquals(1, $this->connection()->fetchOne('SELECT COUNT(*) FROM mail_notification WHERE dropped_at IS NOT NULL'));
    }

    public function testWithoutPreviewsNothingOfTheMailIsKeptWhileItWaits(): void
    {
        $this->patchSettings(['mailPreviews' => false]);
        $this->createEvent($this->minute(-10), ['summary' => 'Budget meeting', 'attendees' => [['address' => 'anna@partner.example', 'name' => 'Anna de Vries']], 'organizerMailAccountId' => $this->accountId]);
        $this->ingest('messages', ['folder' => 'INBOX', 'messages' => [$this->message('1', 'Budget review', ['snippet' => 'The numbers'])]]);
        $this->classifyAndSend();

        self::assertSame([], $this->expoBodies(), 'Held for the meeting.');
        self::assertSame(['New mail from Work', '', null, null], $this->connection()->fetchNumeric('SELECT title, body, sealed_body, delivered_at FROM mail_notification'));
    }

    public function testClassifyingAgainNeverNotifies(): void
    {
        $this->ingest('messages', ['folder' => 'INBOX', 'messages' => [
            $this->message('1', 'Weekly deals', ['from' => ['address' => 'newsletter@shop.example'], 'headers' => ['list-unsubscribe' => '<https://shop.example/u>']]),
            $this->message('2', 'More deals', ['from' => ['address' => 'newsletter@shop.example'], 'headers' => ['list-unsubscribe' => '<https://shop.example/u>']]),
        ]]);
        $this->classifyAndSend();
        $threads = array_column($this->changes()['threads'], 'id', 'subject');
        $todo = $this->builtinId('todo');

        // The user moves one to Todo: the sender's other mail is classified again, and judged `do` for the first time.
        $this->client->jsonRequest('PUT', '/api/v1/threads/'.$threads['Weekly deals'].'/classification', ['smartInboxId' => $todo], $this->kim);
        self::assertResponseIsSuccessful();
        $this->runClassification();
        $this->sendQueued();

        self::assertSame('do', array_column($this->changes()['threads'], 'verdict', 'subject')['More deals']);
        self::assertSame([], $this->expoBodies(), 'Neither the moved conversation nor the rerun pushes: that mail is not new.');
        self::assertEquals(0, $this->connection()->fetchOne('SELECT COUNT(*) FROM mail_notification'));
    }

    public function testNewMailInAConversationTheUserPlacedElsewhereDoesNotNotify(): void
    {
        $this->ingest('messages', ['folder' => 'INBOX', 'messages' => [$this->message('1', 'Budget review', ['messageId' => '<budget@partner.example>'])]]);
        $this->classifyAndSend();
        $threadId = $this->changes()['threads'][0]['id'];
        $this->client->jsonRequest('PUT', '/api/v1/threads/'.$threadId.'/classification', ['smartInboxId' => $this->builtinId('notification')], $this->kim);
        self::assertResponseIsSuccessful();
        $this->runClassification();

        $this->ingest('messages', ['folder' => 'INBOX', 'messages' => [$this->message('2', 'Re: Budget review', ['messageId' => '<reply@partner.example>', 'inReplyTo' => '<budget@partner.example>', 'from' => ['address' => 'bob@partner.example', 'name' => 'Bob']])]]);
        $this->classifyAndSend();

        // Someone else replied: no sender rule applies, so the reply alone would be `do`.
        self::assertSame('do', $this->connection()->fetchOne("SELECT verdict FROM message WHERE subject = 'Re: Budget review'"));
        $page = $this->changes();
        self::assertCount(1, $page['threads'], 'The reply joined the conversation.');
        self::assertSame('know', $page['threads'][0]['verdict'], 'The user\'s placement stays.');
        self::assertCount(1, $this->expoBodies(), 'Only the first message notified.');
    }

    public function testDesktopOnlyMailReachesBrowsersAndTheDesktopApp(): void
    {
        $this->patchSettings(['channelsByKind' => ['mail' => ['desktop']]]);
        $this->ingest('messages', ['folder' => 'INBOX', 'messages' => [$this->message('1', 'Budget review')]]);
        $this->classifyAndSend();

        self::assertSame([], $this->expoBodies());
        self::assertCount(1, $this->http()->requestsTo(self::PUSH_ENDPOINT));
        self::assertSame(['desktop'], $this->changes()['mailNotifications'][0]['channels']);
    }

    public function testWithoutPreviewsOnlyTheAccountIsSaid(): void
    {
        $this->patchSettings(['mailPreviews' => false]);
        self::assertFalse($this->getJson('/api/v1/notification-settings', $this->kim)['mailPreviews']);
        $this->ingest('messages', ['folder' => 'INBOX', 'messages' => [$this->message('1', 'Budget review', ['snippet' => 'The numbers'])]]);
        $this->classifyAndSend();

        $expo = $this->expoBodies();
        self::assertSame('New mail from Work', $expo[0]['title']);
        self::assertSame('', $expo[0]['body']);
        self::assertStringNotContainsString('Budget', json_encode($expo[0], \JSON_THROW_ON_ERROR));
        $delta = $this->changes()['mailNotifications'][0];
        self::assertSame(['New mail from Work', ''], [$delta['title'], $delta['body']], 'The desktop app shows no more than the phone.');
        self::assertSame(['New mail from Work', ''], $this->connection()->fetchNumeric('SELECT title, body FROM mail_notification'), 'Nor does the server keep it.');
    }

    public function testMailTooLateAfterAnOutageIsDropped(): void
    {
        $this->ingest('messages', ['folder' => 'INBOX', 'messages' => [$this->message('1', 'Budget review')]]);
        $this->runClassification();

        $this->notifier()->deliver($this->onlyNotificationId(), new \DateTimeImmutable('+2 hours +1 minute'));

        self::assertSame([], $this->expoBodies());
        self::assertEquals(1, $this->connection()->fetchOne('SELECT COUNT(*) FROM mail_notification WHERE dropped_at IS NOT NULL'));
    }

    public function testASendThatNeverReportedBackIsTriedAgain(): void
    {
        $this->ingest('messages', ['folder' => 'INBOX', 'messages' => [$this->message('1', 'Budget review')]]);
        $this->classifyAndSend();
        // As after a crash between claiming and sending.
        $this->connection()->executeStatement("UPDATE notification_delivery SET status = 'sending', updated_at = updated_at - INTERVAL '11 minutes' WHERE target <> 'email' AND delivery_key LIKE 'mail:%' AND target = (SELECT id::text FROM notification_device WHERE kind = 'web_push')");

        $this->notifier()->sweep(new \DateTimeImmutable());

        self::assertCount(2, $this->http()->requestsTo(self::PUSH_ENDPOINT));
        self::assertCount(1, $this->expoBodies(), 'What went out is never sent again.');
    }

    /** A second account of Kim's, leased by the worker, with an inbox; returns its id. */
    private function homeAccount(): string
    {
        $this->client->jsonRequest('POST', '/api/v1/mail-accounts', [
            'emailAddress' => 'kim@home.example',
            'displayName' => 'Home',
            'username' => 'kim@home.example',
            'password' => 'app-password-2',
            'imap' => ['host' => 'imap.home.example', 'port' => 993, 'security' => 'tls'],
            'smtp' => ['host' => 'smtp.home.example', 'port' => 465, 'security' => 'tls'],
        ], $this->kim);
        $home = $this->responseString('id');
        $this->client->jsonRequest('POST', '/internal/sync/leases', ['workerId' => 'w1'], $this->worker);
        self::assertResponseIsSuccessful();
        $this->client->jsonRequest('POST', '/internal/sync/accounts/'.$home.'/folders', ['workerId' => 'w1', 'folders' => [['remoteName' => 'INBOX', 'displayName' => 'Inbox', 'role' => 'inbox', 'uidValidity' => 1]]], $this->worker);
        self::assertResponseIsSuccessful();

        return $home;
    }

    public function testHeldMailNotifiesOnceWhenItsBatchDeliversIt(): void
    {
        $this->batchedInvoices();
        $this->ingest('messages', ['folder' => 'INBOX', 'messages' => [$this->message('1', 'Invoice 42')]]);
        $this->classifyAndSend();

        self::assertSame([], $this->expoBodies(), 'Held mail waits for its batch.');
        self::assertEquals(0, $this->connection()->fetchOne('SELECT COUNT(*) FROM mail_notification'));

        $this->batchComes();
        $this->batchComes();

        $expo = $this->expoBodies();
        self::assertCount(1, $expo, 'Once, however often the release runs.');
        self::assertSame($this->kimsId()->toRfc4122(), $expo[0]['data']['userId']);
        self::assertCount(1, $this->http()->requestsTo(self::PUSH_ENDPOINT));
    }

    public function testWithoutPreviewsHeldMailSaysOnlyTheAccountWhenItsBatchComes(): void
    {
        $this->patchSettings(['mailPreviews' => false]);
        $this->batchedInvoices();
        $this->ingest('messages', ['folder' => 'INBOX', 'messages' => [$this->message('1', 'Invoice 42', ['snippet' => 'Amount due'])]]);
        $this->classifyAndSend();

        $this->batchComes();

        $expo = $this->expoBodies();
        self::assertCount(1, $expo);
        self::assertSame(['New mail from Work', ''], [$expo[0]['title'], $expo[0]['body']]);
        self::assertStringNotContainsString('Invoice', json_encode($expo[0], \JSON_THROW_ON_ERROR));
        self::assertSame(['New mail from Work', ''], $this->connection()->fetchNumeric('SELECT title, body FROM mail_notification'));
    }

    public function testABatchWithMuchMailThatNeedsTheUserNotifiesOnceWithHowMany(): void
    {
        $this->batchedInvoices();
        $this->ingest('messages', ['folder' => 'INBOX', 'messages' => array_map(fn (int $n): array => $this->message((string) $n, 'Invoice '.$n, ['from' => ['address' => 'anna@partner.example', 'name' => 0 === $n % 2 ? 'Anna de Vries' : 'Billing']]), range(1, 5))]);
        $this->classifyAndSend();

        $this->batchComes();
        $this->batchComes();

        $expo = $this->expoBodies();
        self::assertCount(1, $expo, 'One summary, however often the release runs.');
        self::assertSame('5 new messages to do', $expo[0]['title']);
        self::assertContains($expo[0]['body'], ['From Billing, Anna de Vries', 'From Anna de Vries, Billing']);
        self::assertArrayNotHasKey('threadId', $expo[0]['data'], 'It opens no single conversation.');
        self::assertSame(MailNotifier::BATCHES_PATH, $expo[0]['data']['path'], 'A tap opens the batches.');
        self::assertEquals(1, $this->connection()->fetchOne('SELECT COUNT(*) FROM mail_notification WHERE summary'));
        self::assertEquals(4, $this->connection()->fetchOne('SELECT COUNT(*) FROM mail_notification WHERE summarized_by_id IS NOT NULL'));
        $delta = $this->changes()['mailNotifications'];
        self::assertCount(1, $delta);
        self::assertTrue($delta[0]['summary'], 'The desktop app opens the batches too.');
        self::assertNull($delta[0]['threadId']);
        self::assertSame($this->kimsId()->toRfc4122(), $expo[0]['data']['userId']);
        self::assertEquals(5, $this->connection()->fetchOne('SELECT COUNT(*) FROM mail_notification'));
        self::assertEquals(4, $this->connection()->fetchOne('SELECT COUNT(*) FROM mail_notification WHERE dropped_at IS NOT NULL'), 'The others never notify later either.');
    }

    public function testASummaryCountsAgainAtDeliveryWhatStillNeedsTheUser(): void
    {
        $this->batchedInvoices();
        $this->ingest('messages', ['folder' => 'INBOX', 'messages' => array_map(fn (int $n): array => $this->message((string) $n, 'Invoice '.$n, ['receivedAt' => new \DateTimeImmutable(\sprintf('-%d minutes', 10 - $n))->format(\DATE_ATOM)]), range(1, 5))]);
        $this->classifyAndSend();
        $this->releaseWithoutSending();
        // Read on the phone before the push went out: the newest, which the summary is attached to, and one more.
        $this->connection()->executeStatement("UPDATE message SET seen = true WHERE subject IN ('Invoice 5', 'Invoice 4')");
        static::getContainer()->get(EntityManagerInterface::class)->clear();

        $this->sendQueued();

        $expo = $this->expoBodies();
        self::assertCount(1, $expo, 'The others still need the user.');
        self::assertSame('3 new messages to do', $expo[0]['title']);
    }

    public function testASummaryThatOneMessageStillNeedsOpensThatConversation(): void
    {
        $this->batchedInvoices();
        $this->ingest('messages', ['folder' => 'INBOX', 'messages' => array_map(fn (int $n): array => $this->message((string) $n, 'Invoice '.$n, ['snippet' => 'Amount due '.$n]), range(1, 4))]);
        $this->classifyAndSend();
        $this->releaseWithoutSending();
        $this->connection()->executeStatement("UPDATE message SET seen = true WHERE subject <> 'Invoice 2'");
        static::getContainer()->get(EntityManagerInterface::class)->clear();

        $this->sendQueued();

        $expo = $this->expoBodies();
        self::assertCount(1, $expo);
        self::assertSame(['Anna de Vries', "Invoice 2\nAmount due 2"], [$expo[0]['title'], $expo[0]['body']], 'What that one message says.');
        $thread = $this->connection()->fetchOne("SELECT thread_id FROM message WHERE subject = 'Invoice 2'");
        self::assertSame('/thread/'.self::text($thread), $expo[0]['data']['path'], 'A tap opens its conversation.');
        self::assertSame(self::text($thread), $this->changes()['mailNotifications'][0]['threadId']);
    }

    public function testASummaryWhoseMailWasAllReadMeanwhileIsDropped(): void
    {
        $this->batchedInvoices();
        $this->ingest('messages', ['folder' => 'INBOX', 'messages' => array_map(fn (int $n): array => $this->message((string) $n, 'Invoice '.$n), range(1, 4))]);
        $this->classifyAndSend();
        $this->releaseWithoutSending();
        $this->connection()->executeStatement('UPDATE message SET seen = true');
        static::getContainer()->get(EntityManagerInterface::class)->clear();

        $this->sendQueued();

        self::assertSame([], $this->expoBodies());
        self::assertEquals(1, $this->connection()->fetchOne('SELECT COUNT(*) FROM mail_notification WHERE summary AND dropped_at IS NOT NULL'));
    }

    public function testWithoutPreviewsTheSummarySaysOnlyHowMany(): void
    {
        $this->patchSettings(['mailPreviews' => false]);
        $this->batchedInvoices();
        $this->ingest('messages', ['folder' => 'INBOX', 'messages' => array_map(fn (int $n): array => $this->message((string) $n, 'Invoice '.$n), range(1, 4))]);
        $this->classifyAndSend();

        $this->batchComes();

        $expo = $this->expoBodies();
        self::assertCount(1, $expo);
        self::assertSame(['4 new messages to do', ''], [$expo[0]['title'], $expo[0]['body']]);
        self::assertStringNotContainsString('Anna', json_encode($expo[0], \JSON_THROW_ON_ERROR));
    }

    public function testABatchWithAFewMessagesNotifiesEachOfThem(): void
    {
        $this->batchedInvoices();
        $this->ingest('messages', ['folder' => 'INBOX', 'messages' => array_map(fn (int $n): array => $this->message((string) $n, 'Invoice '.$n), range(1, MailNotifier::SUMMARY_AFTER))]);
        $this->classifyAndSend();

        $this->batchComes();

        self::assertCount(MailNotifier::SUMMARY_AFTER, $this->expoBodies());
    }

    public function testHeldMailReadOrArchivedBeforeItsBatchDoesNotNotify(): void
    {
        $this->batchedInvoices();
        $this->ingest('messages', ['folder' => 'INBOX', 'messages' => [$this->message('1', 'Invoice 42'), $this->message('2', 'Invoice 43')]]);
        $this->classifyAndSend();
        $this->connection()->executeStatement("UPDATE message SET seen = true WHERE subject = 'Invoice 42'");
        $this->connection()->executeStatement(
            "UPDATE message_location SET folder_id = (SELECT id FROM folder WHERE remote_name = 'Archive')
             WHERE message_id = (SELECT id FROM message WHERE subject = 'Invoice 43')",
        );

        $this->batchComes();

        self::assertSame([], $this->expoBodies());
        self::assertEquals(0, $this->connection()->fetchOne('SELECT COUNT(*) FROM mail_notification'));
    }

    public function testANotificationForMailThatIsHeldMeanwhileIsNeverDelivered(): void
    {
        $this->ingest('messages', ['folder' => 'INBOX', 'messages' => [$this->message('1', 'Budget review')]]);
        $this->runClassification();
        $this->connection()->executeStatement("UPDATE message SET held_until = now() + interval '6 hours'");
        static::getContainer()->get(EntityManagerInterface::class)->clear();

        $this->sendQueued();

        self::assertSame([], $this->expoBodies());
        self::assertEquals(1, $this->connection()->fetchOne('SELECT COUNT(*) FROM mail_notification WHERE dropped_at IS NOT NULL'));
    }

    public function testSwitchingBatchesOffDeliversHeldMailWithoutABurstOfPushes(): void
    {
        $smartInboxId = $this->batchedInvoices();
        $this->ingest('messages', ['folder' => 'INBOX', 'messages' => [$this->message('1', 'Invoice 42'), $this->message('2', 'Invoice 43')]]);
        $this->classifyAndSend();

        $this->client->request('PATCH', '/api/v1/smart-inboxes/'.$smartInboxId, server: [...$this->kim, 'CONTENT_TYPE' => 'application/merge-patch+json'], content: '{"batchDelivery": false}');
        self::assertResponseIsSuccessful();
        $this->runClassification();
        $this->sendQueued();
        $this->batchComes();

        self::assertEquals(0, $this->connection()->fetchOne('SELECT COUNT(*) FROM message WHERE held_until IS NOT NULL'), 'Delivered at once.');
        self::assertSame([], $this->expoBodies(), 'A settings change, like classifying again, pushes nothing.');
    }

    public function testAHeldConversationTheUserMovesDoesNotNotify(): void
    {
        $this->batchedInvoices();
        $this->ingest('messages', ['folder' => 'INBOX', 'messages' => [$this->message('1', 'Invoice 42')]]);
        $this->classifyAndSend();

        $this->client->jsonRequest('PUT', '/api/v1/threads/'.$this->changes()['threads'][0]['id'].'/classification', ['smartInboxId' => $this->builtinId('todo')], $this->kim);
        self::assertResponseIsSuccessful();
        $this->sendQueued();
        $this->batchComes();

        self::assertSame([], $this->expoBodies(), 'The user is looking at it: delivered, without a push.');
    }

    /**
     * A smart inbox for mail from Anna that is to do and delivers in batches, with one batch a day six hours from now:
     * mail received now waits for it.
     */
    private function batchedInvoices(): string
    {
        $this->client->jsonRequest('POST', '/api/v1/smart-inboxes', ['name' => 'Invoices', 'includeSenders' => ['anna@partner.example'], 'verdict' => 'do', 'batchDelivery' => true], $this->kim);
        self::assertResponseStatusCodeSame(201);
        $id = $this->responseString('id');
        $this->client->jsonRequest('PUT', '/api/v1/batch-delivery', ['times' => [new \DateTimeImmutable('+6 hours', new \DateTimeZone('UTC'))->format('H:i')], 'timeZone' => 'UTC'], $this->kim);
        self::assertResponseIsSuccessful();
        // The reclassification the new smart inbox queued has nothing to do yet.
        $this->runClassification();

        return $id;
    }

    /** The batch time comes: the sweep releases what waits and its notifications go out. */
    private function batchComes(): void
    {
        $this->releaseWithoutSending();
        $this->sendQueued();
    }

    /** The batch time comes and the sweep releases what waits; its notifications are still on their way. */
    private function releaseWithoutSending(): void
    {
        foreach (['message', 'thread'] as $table) {
            $this->connection()->executeStatement("UPDATE {$table} SET held_until = now() - interval '1 minute' WHERE held_until IS NOT NULL");
        }
        static::getContainer()->get(EntityManagerInterface::class)->clear();
        static::getContainer()->get(ReleaseBatchHandler::class)->sweep(new SweepBatches());
    }

    private function builtinId(string $builtin): string
    {
        $smartInboxes = $this->getJson('/api/v1/sync/changes?since=0&limit=2000', $this->kim)['smartInboxes'];
        self::assertIsArray($smartInboxes);
        foreach ($smartInboxes as $smartInbox) {
            if (\is_array($smartInbox) && $builtin === $smartInbox['builtin'] && \is_string($smartInbox['id'])) {
                return $smartInbox['id'];
            }
        }
        self::fail('No built-in smart inbox '.$builtin.'.');
    }

    private function classifyAndSend(): void
    {
        $this->runClassification();
        $this->sendQueued();
    }

    /** Runs the classification queued by the ingest, the way the classify worker does. */
    private function runClassification(): void
    {
        $transport = static::getContainer()->get('messenger.transport.classify');
        self::assertInstanceOf(InMemoryTransport::class, $transport);
        $bus = static::getContainer()->get(MessageBusInterface::class);
        while ([] !== ($envelopes = array_values([...$transport->get()]))) {
            $transport->reset();
            foreach ($envelopes as $envelope) {
                $bus->dispatch($envelope->with(new ReceivedStamp('classify')));
            }
        }
    }

    /** Delivers the mail notifications classification queued, the way the push worker does (delays aside). */
    private function sendQueued(): void
    {
        $transport = $this->pushTransport();
        // The transport hands out one envelope at a time, as a worker fetches them.
        $all = [];
        while ([] !== ($fetched = [...$transport->get()])) {
            foreach ($fetched as $envelope) {
                $transport->ack($envelope);
                $all[] = $envelope;
            }
        }
        $envelopes = array_values(array_filter($all, static fn ($envelope): bool => $envelope->getMessage() instanceof SendMailNotification));
        $transport->reset();
        foreach ($envelopes as $envelope) {
            $message = $envelope->getMessage();
            self::assertInstanceOf(SendMailNotification::class, $message);
            $this->notifier()->onSend($message);
        }
    }

    private function pushTransport(): InMemoryTransport
    {
        $transport = static::getContainer()->get('messenger.transport.push');
        self::assertInstanceOf(InMemoryTransport::class, $transport);

        return $transport;
    }

    /**
     * Creates an event at that start (30 minutes long) and runs the planning it causes.
     *
     * @param array<string, mixed> $overrides
     */
    private function createEvent(\DateTimeImmutable $start, array $overrides): void
    {
        $local = $start->setTimezone(new \DateTimeZone('Europe/Amsterdam'));
        $this->client->jsonRequest('POST', '/api/v1/calendar-events', self::event($this->localCalendarId($this->kim), [
            'start' => ['dateTime' => $local->format('Y-m-d\TH:i:s'), 'timeZone' => 'Europe/Amsterdam'],
            'end' => ['dateTime' => $local->modify('+30 minutes')->format('Y-m-d\TH:i:s'), 'timeZone' => 'Europe/Amsterdam'],
            ...$overrides,
        ]), $this->kim);
        self::assertResponseStatusCodeSame(201);
        $transport = $this->pushTransport();
        $handlers = static::getContainer()->get(NotificationHandlers::class);
        foreach ($transport->getSent() as $envelope) {
            $message = $envelope->getMessage();
            if ($message instanceof PlanCalendarObject) {
                $handlers->plan($message);
            }
        }
        $transport->reset();
    }

    private function minute(int $offset): \DateTimeImmutable
    {
        $moment = new \DateTimeImmutable(\sprintf('%+d minutes', $offset), new \DateTimeZone('UTC'));

        return $moment->setTime((int) $moment->format('H'), (int) $moment->format('i'));
    }

    private function onlyNotificationId(): string
    {
        $id = $this->connection()->fetchOne('SELECT id FROM mail_notification');
        self::assertIsString($id);

        return $id;
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

    /**
     * @param array<string, mixed> $changes
     */
    private function patchSettings(array $changes): void
    {
        $this->client->request('PATCH', '/api/v1/notification-settings', server: [...$this->kim, 'CONTENT_TYPE' => 'application/merge-patch+json'], content: json_encode($changes, \JSON_THROW_ON_ERROR));
        self::assertResponseIsSuccessful();
    }

    /**
     * @param array<string, mixed> $payload
     */
    private function ingest(string $action, array $payload): void
    {
        $this->client->jsonRequest('POST', '/internal/sync/accounts/'.$this->accountId.'/'.$action, ['workerId' => 'w1'] + $payload, $this->worker);
        self::assertResponseIsSuccessful();
    }

    /**
     * @return array{threads: list<array{id: string, subject: string, verdict: ?string}>, mailNotifications: list<array<string, mixed>>}
     */
    private function changes(): array
    {
        /** @var array{threads: list<array{id: string, subject: string, verdict: ?string}>, mailNotifications: list<array<string, mixed>>} */
        return $this->getJson('/api/v1/sync/changes?since=0&limit=2000', $this->kim);
    }

    /**
     * @param array<string, mixed> $override
     *
     * @return array<string, mixed>
     */
    private function message(string $uid, string $subject, array $override = []): array
    {
        $sha = hash('sha256', $uid.$subject);

        return [...[
            'remoteUid' => $uid,
            'rawObjectKey' => $this->rawKeyFor($this->accountId, $uid.$subject),
            'keyVersion' => 1,
            'size' => 100,
            'receivedAt' => new \DateTimeImmutable('-2 minutes')->format(\DATE_ATOM),
            'messageId' => '<'.$sha.'@x>',
            'subject' => $subject,
            'from' => ['address' => 'anna@partner.example', 'name' => 'Anna de Vries'],
            'to' => [['address' => self::ME]],
            'snippet' => '',
            'flags' => ['seen' => false, 'flagged' => false, 'answered' => false, 'draft' => false],
        ], ...$override];
    }

    private function notifier(): MailNotifier
    {
        return static::getContainer()->get(MailNotifier::class);
    }

    private function kim(): User
    {
        return static::getContainer()->get(UserRepository::class)->findOneBy(['email' => 'kim@example.test']) ?? self::fail('No user.');
    }

    private function kimsId(): Uuid
    {
        return $this->kim()->getId();
    }

    private function http(): MockHttpRouter
    {
        return static::getContainer()->get(MockHttpRouter::class);
    }

    private static function text(mixed $value): string
    {
        self::assertIsString($value);

        return $value;
    }
}
