<?php

declare(strict_types=1);

namespace App\Tests\Functional;

use App\Entity\Attachment;
use App\Entity\Folder;
use App\Entity\Message;
use App\Entity\MessageLocation;
use App\Entity\MessageText;
use App\Entity\Thread;
use App\Entity\Todo;
use App\Mail\MessageFields;
use App\Repository\AttachmentRepository;
use App\Storage\BlobKey;
use App\Storage\BlobKind;
use App\Tests\Support\QueryLog;
use Doctrine\ORM\EntityManagerInterface;
use Symfony\Component\Uid\Uuid;

final class SyncIngestTest extends DatabaseTestCase
{
    use AuthenticatesUsers;
    use StoresMail;

    private string $accountId;

    /** @var array<string, string> */
    private array $worker;

    protected function setUp(): void
    {
        parent::setUp();
        $this->bootstrapOAuthClients();
        $this->createUser('kim@example.test', 'Kim Visser');

        $this->client->jsonRequest('POST', '/api/v1/mail-accounts', [
            'emailAddress' => 'kim@company.example',
            'displayName' => 'Work',
            'username' => 'kim@company.example',
            'password' => 'app-password-1',
            'imap' => ['host' => 'imap.company.example', 'port' => 993, 'security' => 'tls'],
            'smtp' => ['host' => 'smtp.company.example', 'port' => 465, 'security' => 'tls'],
        ], $this->userHeaders('kim@example.test', ['settings:write']));
        $this->accountId = $this->responseString('id');

        $this->worker = $this->workerHeaders('sync:lease sync:ingest');
        $this->client->jsonRequest('POST', '/internal/sync/leases', ['workerId' => 'w1'], $this->worker);
        self::assertResponseIsSuccessful();
    }

    public function testFolderListReturnsStoredCursors(): void
    {
        $states = $this->folders(['INBOX' => 1, 'Sent' => 1]);
        self::assertSame([
            ['remoteName' => 'INBOX', 'uidValidity' => 1, 'cursor' => null, 'reset' => false],
            ['remoteName' => 'Sent', 'uidValidity' => 1, 'cursor' => null, 'reset' => false],
        ], $states);

        $this->messages('INBOX', [$this->message('1')], 'uidnext=2');

        self::assertSame('uidnext=2', $this->folders(['INBOX' => 1, 'Sent' => 1])[0]['cursor'] ?? null);
    }

    public function testUidValidityChangeResetsFolderAndDropsItsMessages(): void
    {
        $this->folders(['INBOX' => 1]);
        $this->messages('INBOX', [$this->message('1')], 'c1');

        $states = $this->folders(['INBOX' => 2]);

        self::assertSame([['remoteName' => 'INBOX', 'uidValidity' => 2, 'cursor' => null, 'reset' => true]], $states);
        self::assertSame(0, $this->rows(MessageLocation::class));
        self::assertNotNull($this->onlyMessage()->getOrphanedAt(), 'It waits for the download of the folder to find it again.');

        $this->sweepOrphanedMessages();

        self::assertSame(0, $this->rows(Message::class));
    }

    public function testAResetFolderFindsItsMessagesAgain(): void
    {
        $this->folders(['INBOX' => 1]);
        $this->messages('INBOX', [$this->message('1', ['messageId' => '<kept@x>'])]);
        $id = $this->onlyMessage()->getId();

        $this->folders(['INBOX' => 2]);
        $this->messages('INBOX', [$this->message('31', ['messageId' => '<kept@x>'])]);
        $this->sweepOrphanedMessages();

        $message = $this->onlyMessage();
        self::assertTrue($id->equals($message->getId()));
        self::assertNull($message->getOrphanedAt());
    }

    public function testDeletedFolderTakesOnlyMessagesThatAreNowhereElse(): void
    {
        $this->folders(['INBOX' => 1, 'Projects' => 1]);
        $this->messages('INBOX', [$this->message('1', ['messageId' => '<shared@x>'])]);
        $this->messages('Projects', [$this->message('7', ['messageId' => '<shared@x>']), $this->message('8', ['messageId' => '<only-here@x>'])]);
        self::assertSame(2, $this->rows(Message::class));

        $this->folders(['INBOX' => 1]);
        $this->sweepOrphanedMessages();

        self::assertSame(1, $this->rows(Message::class));
        self::assertSame(1, $this->rows(MessageLocation::class));
    }

    public function testStoresMessageWithRecipientsAttachmentsAndFlags(): void
    {
        $this->folders(['INBOX' => 1]);
        $fingerprintA = $this->fingerprintFor($this->accountId, 'a');
        $fingerprintB = $this->fingerprintFor($this->accountId, 'b');

        $result = $this->messages('INBOX', [$this->message('42', [
            'messageId' => '<budget-1@finance.example>',
            'subject' => 'Q4 budget, revised',
            'from' => ['address' => 'Anna@Finance.example', 'name' => 'Anna de Vries'],
            'to' => [['address' => 'kim@company.example', 'name' => 'Kim']],
            'cc' => [['address' => 'pieter@company.example']],
            'snippet' => 'Could you approve the revised numbers before Friday?',
            'flags' => ['seen' => true, 'flagged' => true, 'answered' => false, 'draft' => false],
            'attachments' => [
                ['filename' => 'budget.xlsx', 'contentType' => 'application/vnd.ms-excel', 'size' => 48000, 'fingerprint' => $fingerprintA],
                ['filename' => 'logo.png', 'contentType' => 'image/png', 'size' => 1200, 'fingerprint' => $fingerprintB, 'contentId' => 'logo@x', 'inline' => true],
            ],
        ])]);

        self::assertSame(['stored' => 1, 'linked' => 0, 'updated' => 0], $result);
        $message = $this->onlyMessage();
        self::assertSame('budget-1@finance.example', $message->getMessageIdHeader());
        self::assertSame('anna@finance.example', $message->getFromAddress());
        self::assertSame('Anna de Vries', $message->getFromName());
        self::assertSame([['address' => 'kim@company.example', 'name' => 'Kim']], $message->getRecipients()['to']);
        self::assertSame([['address' => 'pieter@company.example', 'name' => null]], $message->getRecipients()['cc']);
        self::assertTrue($message->isSeen());
        self::assertTrue($message->isFlagged());
        self::assertTrue($message->hasAttachments());
        self::assertSame('Q4 budget, revised', $message->getThread()->getSubject());
        self::assertSame(1, $message->getThread()->getMessageCount());

        $attachments = $this->entityManager()->getRepository(Attachment::class)->findBy(['message' => $message], ['filename' => 'ASC']);
        self::assertCount(2, $attachments);
        self::assertFalse($attachments[0]->isInline());
        self::assertTrue($attachments[1]->isInline());
        self::assertSame(BlobKey::of(BlobKind::Attachments, $this->accountOwner($this->accountId), $fingerprintA), $attachments[0]->getObjectKey());
        self::assertSame(1, $attachments[0]->getKeyVersion());
    }

    public function testDatesWithAnOffsetAreKeptAsThatMoment(): void
    {
        $this->folders(['INBOX' => 1]);

        $this->messages('INBOX', [$this->message('1', ['sentAt' => '2026-10-19T09:59:00+02:00', 'receivedAt' => '2026-10-19T10:00:00+02:00'])]);

        $message = $this->onlyMessage();
        self::assertSame(new \DateTimeImmutable('2026-10-19T07:59:00+00:00')->getTimestamp(), $message->getSentAt()?->getTimestamp());
        self::assertSame(new \DateTimeImmutable('2026-10-19T08:00:00+00:00')->getTimestamp(), $message->getReceivedAt()->getTimestamp());
        self::assertSame(new \DateTimeImmutable('2026-10-19T08:00:00+00:00')->getTimestamp(), $message->getThread()->getLastMessageAt()->getTimestamp());
    }

    public function testOnlyInlineAttachmentsDoNotCountAsAttachments(): void
    {
        $this->folders(['INBOX' => 1]);
        $this->messages('INBOX', [$this->message('1', [
            'attachments' => [['filename' => 'logo.png', 'contentType' => 'image/png', 'size' => 10, 'fingerprint' => $this->fingerprintFor($this->accountId, 'logo'), 'contentId' => 'logo', 'inline' => true]],
        ])]);

        self::assertFalse($this->onlyMessage()->hasAttachments());
    }

    public function testKeepsTheBodyTextForSearch(): void
    {
        $this->folders(['INBOX' => 1]);

        $this->messages('INBOX', [$this->message('1', ['bodyText' => 'Could you approve the revised numbers?']), $this->message('2')]);

        $texts = $this->entityManager()->getRepository(MessageText::class)->findAll();
        self::assertCount(1, $texts, 'A message without text gets no row.');
        self::assertSame('Could you approve the revised numbers?', static::getContainer()->get(MessageFields::class)->text($texts[0]));
        self::assertSame('msg-1@test.example', $texts[0]->getMessage()->getMessageIdHeader());
    }

    public function testSealsTheBodyTextAndSnippet(): void
    {
        $this->folders(['INBOX' => 1]);

        $this->messages('INBOX', [$this->message('1', ['snippet' => 'Approve the revised numbers', 'bodyText' => 'Could you approve the revised numbers?'])]);

        $row = $this->connection()->fetchAssociative('SELECT m.snippet, m.sealed_snippet, t.text, t.sealed_text FROM message m JOIN message_text t ON t.message_id = m.id');
        self::assertIsArray($row);
        self::assertSame('', $row['snippet']);
        self::assertNull($row['text']);
        foreach (['sealed_snippet', 'sealed_text'] as $column) {
            self::assertIsString($row[$column]);
            self::assertStringStartsWith('f1.1.', $row[$column]);
            self::assertStringNotContainsString('revised', (string) base64_decode(explode('.', $row[$column], 3)[2], true));
        }
        self::assertSame('Approve the revised numbers', static::getContainer()->get(MessageFields::class)->snippet($this->onlyMessage()));
    }

    public function testRawContentMustBeStoredUnderTheAccountOwner(): void
    {
        $this->folders(['INBOX' => 1]);
        $otherOwner = Uuid::v7();
        $key = BlobKey::of(BlobKind::Raw, $otherOwner, hash('sha256', 'elsewhere'));

        $this->client->jsonRequest('POST', $this->url('messages'), ['workerId' => 'w1', 'folder' => 'INBOX', 'messages' => [$this->message('1', ['rawObjectKey' => $key])]], $this->worker);

        self::assertResponseStatusCodeSame(422);
        self::assertSame(0, $this->rows(Message::class));
    }

    public function testRawContentMustBeOfTheRawKind(): void
    {
        $this->folders(['INBOX' => 1]);
        $key = BlobKey::of(BlobKind::Uploads, $this->accountOwner($this->accountId), hash('sha256', 'an upload'));

        $this->client->jsonRequest('POST', $this->url('messages'), ['workerId' => 'w1', 'folder' => 'INBOX', 'messages' => [$this->message('1', ['rawObjectKey' => $key])]], $this->worker);

        self::assertResponseStatusCodeSame(422);
    }

    public function testAKeyVersionTheOwnerDoesNotHaveIsRefused(): void
    {
        $this->folders(['INBOX' => 1]);

        $this->client->jsonRequest('POST', $this->url('messages'), ['workerId' => 'w1', 'folder' => 'INBOX', 'messages' => [$this->message('1', ['keyVersion' => 7])]], $this->worker);

        self::assertResponseStatusCodeSame(422);
        self::assertStringContainsString('key version 7', (string) $this->client->getResponse()->getContent());
    }

    public function testKeyVersionsCannotBeRetiredWhileABatchNamingThemIsStored(): void
    {
        $this->folders(['INBOX' => 1]);
        $log = static::getContainer()->get(QueryLog::class);
        $log->clear();

        $this->messages('INBOX', [$this->message('1')]);

        $queries = $log->queries();
        $locked = array_key_first(array_filter($queries, static fn (string $sql): bool => str_starts_with($sql, 'SELECT id FROM app_user WHERE id = ') && str_ends_with($sql, 'FOR SHARE')));
        $stored = array_key_first(array_filter($queries, static fn (string $sql): bool => str_starts_with($sql, 'INSERT INTO message ')));
        self::assertNotNull($locked, 'The owner is locked shared, which retiring a key version (FOR UPDATE) waits for.');
        self::assertNotNull($stored);
        self::assertLessThan($stored, $locked, 'Locked before anything naming a key version is stored.');
    }

    public function testRawContentFromBeforeEncryptionIsRefused(): void
    {
        $this->folders(['INBOX' => 1]);
        $sha = hash('sha256', 'plaintext');

        $this->client->jsonRequest('POST', $this->url('messages'), ['workerId' => 'w1', 'folder' => 'INBOX', 'messages' => [$this->message('1', ['rawObjectKey' => 'raw/'.substr($sha, 0, 2).'/'.$sha])]], $this->worker);

        self::assertResponseStatusCodeSame(422);
    }

    public function testBodyTextLongerThanTheLimitIsRejected(): void
    {
        $this->folders(['INBOX' => 1]);

        $this->client->jsonRequest('POST', $this->url('messages'), ['workerId' => 'w1', 'folder' => 'INBOX', 'messages' => [$this->message('1', ['bodyText' => str_repeat('é', MessageText::MAX_LENGTH + 1)])]], $this->worker);

        self::assertResponseStatusCodeSame(422);
        self::assertStringContainsString('bodyText', (string) $this->client->getResponse()->getContent());
    }

    public function testRegularAttachmentsKeepTheirContentId(): void
    {
        $this->folders(['INBOX' => 1]);
        $fingerprint = $this->fingerprintFor($this->accountId, 'photo');

        $this->messages('INBOX', [$this->message('1', [
            'attachments' => [['filename' => 'photo.png', 'contentType' => 'image/png', 'size' => 10, 'fingerprint' => $fingerprint, 'contentId' => 'photo@x', 'inline' => false]],
        ])]);

        $attachment = static::getContainer()->get(AttachmentRepository::class)->findOneBy(['sha256' => $fingerprint]);
        self::assertInstanceOf(Attachment::class, $attachment);
        self::assertSame('photo@x', $attachment->getContentId());
        self::assertFalse($attachment->isInline());
        self::assertTrue($this->onlyMessage()->hasAttachments());
    }

    public function testResendingABatchChangesNothing(): void
    {
        $this->folders(['INBOX' => 1]);
        $batch = [$this->message('1', ['messageId' => '<a@x>']), $this->message('2', ['messageId' => '<b@x>'])];

        self::assertSame(['stored' => 2, 'linked' => 0, 'updated' => 0], $this->messages('INBOX', $batch));
        self::assertSame(['stored' => 0, 'linked' => 0, 'updated' => 2], $this->messages('INBOX', $batch));
        self::assertSame(2, $this->rows(Message::class));
        self::assertSame(2, $this->rows(MessageLocation::class));
    }

    public function testSameMessageInTwoFoldersIsStoredOnce(): void
    {
        $this->folders(['INBOX' => 1, 'Archive' => 1]);

        $this->messages('INBOX', [$this->message('1', ['messageId' => '<same@x>'])]);
        $result = $this->messages('Archive', [$this->message('900', ['messageId' => 'same@x'])]);

        self::assertSame(['stored' => 0, 'linked' => 1, 'updated' => 0], $result);
        self::assertSame(1, $this->rows(Message::class));
        self::assertSame(2, $this->rows(MessageLocation::class));
    }

    public function testAnotherMailWithTheSameMessageIdIsStoredOnItsOwn(): void
    {
        $this->folders(['INBOX' => 1]);

        $this->messages('INBOX', [$this->message('1', ['messageId' => '<fixed@device.example>', 'subject' => 'Door opened', 'from' => ['address' => 'camera@device.example']])]);
        $result = $this->messages('INBOX', [$this->message('2', [
            'messageId' => '<fixed@device.example>',
            'rawObjectKey' => $this->rawKeyFor($this->accountId, 'another mail'),
            'subject' => 'Invoice 2026-114',
            'from' => ['address' => 'billing@supplier.example'],
        ])]);

        self::assertSame(['stored' => 1, 'linked' => 0, 'updated' => 0], $result);
        self::assertSame(2, $this->rows(Message::class));
    }

    public function testACopyTheServerRewroteIsLinkedBySenderDateAndSubject(): void
    {
        $this->folders(['INBOX' => 1, 'Archive' => 1]);
        $copy = ['messageId' => '<same@x>', 'subject' => 'Offsite', 'from' => ['address' => 'anna@finance.example'], 'sentAt' => '2026-10-19T09:59:00+02:00'];

        $this->messages('INBOX', [$this->message('1', $copy)]);
        $result = $this->messages('Archive', [$this->message('2', ['rawObjectKey' => $this->rawKeyFor($this->accountId, 'rewritten')] + $copy)]);

        self::assertSame(['stored' => 0, 'linked' => 1, 'updated' => 0], $result);
        self::assertSame(1, $this->rows(Message::class));
    }

    public function testMessageWithoutMessageIdIsMatchedByRawContent(): void
    {
        $this->folders(['INBOX' => 1, 'Archive' => 1]);
        $raw = $this->rawKeyFor($this->accountId, 'no-message-id');

        $this->messages('INBOX', [$this->message('1', ['messageId' => null, 'rawObjectKey' => $raw])]);
        $this->messages('Archive', [$this->message('2', ['messageId' => null, 'rawObjectKey' => $raw])]);

        self::assertSame(1, $this->rows(Message::class));
    }

    public function testRepliesJoinTheirParentsThread(): void
    {
        $this->folders(['INBOX' => 1]);

        $this->messages('INBOX', [
            $this->message('1', ['messageId' => '<root@x>', 'subject' => 'Offsite']),
            $this->message('2', ['messageId' => '<reply@x>', 'subject' => 'Re: Offsite', 'inReplyTo' => '<root@x>', 'references' => ['<root@x>']]),
        ]);

        self::assertSame(1, $this->rows(Thread::class));
        self::assertSame(2, $this->onlyThread()->getMessageCount());
    }

    public function testReplyThatArrivesFirstIsJoinedByItsParent(): void
    {
        $this->folders(['INBOX' => 1]);

        $this->messages('INBOX', [$this->message('2', ['messageId' => '<reply@x>', 'subject' => 'Re: Offsite', 'inReplyTo' => '<root@x>'])]);
        $this->messages('INBOX', [$this->message('1', ['messageId' => '<root@x>', 'subject' => 'Offsite'])]);

        self::assertSame(1, $this->rows(Thread::class));
    }

    public function testMissingMiddleMessageMergesTwoThreads(): void
    {
        $this->folders(['INBOX' => 1]);
        $this->messages('INBOX', [
            $this->message('1', ['messageId' => '<a@x>', 'subject' => 'Plan']),
            $this->message('3', ['messageId' => '<c@x>', 'subject' => 'Re: Plan', 'inReplyTo' => '<b@x>', 'references' => ['<b@x>']]),
        ]);
        self::assertSame(2, $this->rows(Thread::class));

        $this->messages('INBOX', [$this->message('2', ['messageId' => '<b@x>', 'subject' => 'Re: Plan', 'inReplyTo' => '<a@x>', 'references' => ['<a@x>']])]);

        self::assertSame(1, $this->rows(Thread::class));
        self::assertSame(3, $this->onlyThread()->getMessageCount());
    }

    public function testSubjectFallbackNeedsASharedParticipantAndRecentThread(): void
    {
        $this->folders(['INBOX' => 1]);
        $anna = ['address' => 'anna@finance.example'];

        $this->messages('INBOX', [
            $this->message('1', ['messageId' => '<s1@x>', 'subject' => 'Budget', 'from' => $anna, 'receivedAt' => '2026-10-01T09:00:00+00:00']),
            $this->message('2', ['messageId' => '<s2@x>', 'subject' => 'RE: Budget', 'from' => $anna, 'receivedAt' => '2026-10-02T09:00:00+00:00']),
            $this->message('3', ['messageId' => '<s3@x>', 'subject' => 'Budget', 'from' => ['address' => 'stranger@other.example'], 'to' => [['address' => 'kim@company.example']], 'receivedAt' => '2026-10-03T09:00:00+00:00']),
            $this->message('4', ['messageId' => '<s4@x>', 'subject' => 'Fwd: Budget', 'from' => $anna, 'receivedAt' => '2026-12-01T09:00:00+00:00']),
        ]);

        $threads = $this->entityManager()->getRepository(Thread::class)->findBy([], ['lastMessageAt' => 'ASC']);
        self::assertCount(3, $threads, 'Same sender joins; a stranger and a much later mail start their own threads.');
        self::assertSame([2, 1, 1], array_map(static fn (Thread $t): int => $t->getMessageCount(), $threads));
    }

    public function testSubjectFallbackDoesNotJoinAStrangerToAConversationTheUserWroteIn(): void
    {
        $this->folders(['INBOX' => 1, 'Sent' => 1]);
        $kim = ['address' => 'kim@company.example'];

        $this->messages('Sent', [$this->message('1', ['messageId' => '<sent-1@x>', 'subject' => 'Budget', 'from' => $kim, 'to' => [['address' => 'anna@finance.example']], 'receivedAt' => '2026-10-01T09:00:00+00:00'])]);
        $this->messages('INBOX', [$this->message('2', ['messageId' => '<in-1@x>', 'subject' => 'Budget', 'from' => ['address' => 'stranger@other.example'], 'to' => [$kim], 'receivedAt' => '2026-10-02T09:00:00+00:00'])]);

        self::assertSame(2, $this->rows(Thread::class), 'Only the user is on both, so they are not one conversation.');

        $this->messages('INBOX', [$this->message('3', ['messageId' => '<in-2@x>', 'subject' => 'Re: Budget', 'from' => ['address' => 'Anna@Finance.example'], 'to' => [$kim], 'receivedAt' => '2026-10-03T09:00:00+00:00'])]);

        self::assertSame(2, $this->rows(Thread::class), 'Anna answers without References and joins the mail the user sent her.');
        $sent = $this->entityManager()->getRepository(Message::class)->findOneBy(['messageIdHeader' => 'sent-1@x']);
        self::assertInstanceOf(Message::class, $sent);
        self::assertSame(2, $sent->getThread()->getMessageCount());
    }

    public function testSubjectFallbackKeepsTheUsersMailToDifferentPeopleApart(): void
    {
        $this->folders(['INBOX' => 1, 'Sent' => 1]);
        $kim = ['address' => 'kim@company.example'];

        $this->messages('Sent', [
            $this->message('1', ['messageId' => '<sent-1@x>', 'subject' => 'Invoice', 'from' => $kim, 'to' => [['address' => 'anna@finance.example']], 'receivedAt' => '2026-10-01T09:00:00+00:00']),
            $this->message('2', ['messageId' => '<sent-2@x>', 'subject' => 'Invoice', 'from' => $kim, 'to' => [['address' => 'bert@supplier.example']], 'receivedAt' => '2026-10-02T09:00:00+00:00']),
        ]);

        self::assertSame(2, $this->rows(Thread::class));
    }

    public function testChangesUpdateFlagsAndRemoveMessages(): void
    {
        $this->folders(['INBOX' => 1, 'Archive' => 1]);
        $this->messages('INBOX', [
            $this->message('1', ['messageId' => '<keep@x>']),
            $this->message('2', ['messageId' => '<gone@x>', 'subject' => 'Re: x', 'inReplyTo' => '<keep@x>']),
            $this->message('3', ['messageId' => '<moved@x>']),
        ]);
        $this->messages('Archive', [$this->message('50', ['messageId' => '<moved@x>'])]);

        $result = $this->changes('INBOX', [
            'flags' => [['remoteUid' => '1', 'modSeq' => 9, 'flags' => ['seen' => true, 'flagged' => false, 'answered' => true, 'draft' => false]], ['remoteUid' => '99', 'flags' => ['seen' => true]]],
            'vanished' => ['2', '3'],
            'cursor' => 'modseq=9',
        ]);

        self::assertSame(['updated' => 1, 'removed' => 2, 'unknown' => 1, 'deleted' => 1, 'unknownUids' => ['99']], $result);
        $gone = $this->entityManager()->getRepository(Message::class)->findOneBy(['messageIdHeader' => 'gone@x']);
        self::assertInstanceOf(Message::class, $gone, 'It waits for its copy to show up elsewhere.');
        self::assertNotNull($gone->getOrphanedAt());

        $this->sweepOrphanedMessages('+5 minutes');
        self::assertNotNull($this->entityManager()->getRepository(Message::class)->findOneBy(['messageIdHeader' => 'gone@x']), 'Still within its grace period.');

        $this->sweepOrphanedMessages();
        self::assertNull($this->entityManager()->getRepository(Message::class)->findOneBy(['messageIdHeader' => 'gone@x']));
        $keep = $this->entityManager()->getRepository(Message::class)->findOneBy(['messageIdHeader' => 'keep@x']);
        self::assertInstanceOf(Message::class, $keep);
        self::assertTrue($keep->isSeen());
        self::assertTrue($keep->isAnswered());
        self::assertSame(1, $keep->getThread()->getMessageCount(), 'The thread is recounted after its reply was deleted.');
        self::assertNotNull($this->entityManager()->getRepository(Message::class)->findOneBy(['messageIdHeader' => 'moved@x']), 'Still in Archive.');
        self::assertSame('modseq=9', $this->folders(['INBOX' => 1, 'Archive' => 1])[0]['cursor'] ?? null);
    }

    public function testAMessageMovedInAnotherMailAppKeepsItsIdentityAndItsTodo(): void
    {
        $this->folders(['INBOX' => 1, 'Archive' => 1]);
        $this->messages('INBOX', [$this->message('1', ['messageId' => '<moved@x>'])]);
        $id = $this->onlyMessage()->getId()->toRfc4122();
        $this->client->jsonRequest('POST', '/api/v1/messages/'.$id.'/todo', [], $this->userHeaders('kim@example.test', ['mail:read', 'todos:write']));
        self::assertResponseIsSuccessful();
        $todoId = $this->responseString('id');

        // The worker sees the copy leave the inbox before its folder poll finds it in Archive.
        self::assertSame(1, $this->changes('INBOX', ['vanished' => ['1']])['deleted']);
        $this->sweepOrphanedMessages('+5 minutes');
        $result = $this->messages('Archive', [$this->message('40', ['messageId' => '<moved@x>'])]);
        $this->sweepOrphanedMessages();

        self::assertSame(['stored' => 0, 'linked' => 1, 'updated' => 0], $result);
        $message = $this->onlyMessage();
        self::assertSame($id, $message->getId()->toRfc4122());
        self::assertNull($message->getOrphanedAt());
        $todo = $this->entityManager()->find(Todo::class, Uuid::fromString($todoId));
        self::assertInstanceOf(Todo::class, $todo);
        self::assertSame($id, $todo->getMessage()?->getId()->toRfc4122());
    }

    public function testAnOrphanIsDeletedWithATombstoneAfterItsGracePeriod(): void
    {
        $this->folders(['INBOX' => 1]);
        $this->messages('INBOX', [$this->message('1', ['messageId' => '<gone@x>'])]);
        $message = $this->onlyMessage();
        $id = $message->getId()->toRfc4122();
        $threadId = $message->getThread()->getId()->toRfc4122();
        $this->changes('INBOX', ['vanished' => ['1']]);

        $this->sweepOrphanedMessages();

        self::assertSame(0, $this->rows(Message::class));
        self::assertSame(0, $this->rows(Thread::class));
        self::assertSame(1, $this->countRows("SELECT COUNT(*) FROM sync_tombstone WHERE entity_type = 'message' AND entity_id = :id", ['id' => $id]));
        self::assertSame(1, $this->countRows("SELECT COUNT(*) FROM sync_tombstone WHERE entity_type = 'thread' AND entity_id = :id", ['id' => $threadId]));
    }

    public function testACursorOnlyChangeBatchLeavesTheMessagesAlone(): void
    {
        $this->folders(['INBOX' => 1]);
        $this->messages('INBOX', [$this->message('1'), $this->message('2')]);
        $log = static::getContainer()->get(QueryLog::class);
        $log->clear();

        $result = $this->changes('INBOX', ['cursor' => 'modseq=5']);

        self::assertSame(['updated' => 0, 'removed' => 0, 'unknown' => 0, 'deleted' => 0, 'unknownUids' => []], $result);
        $touching = array_filter($log->queries(), static fn (string $sql): bool => (bool) preg_match('/\b(FROM|UPDATE|INTO|JOIN)\s+message\b(?!_)/i', $sql));
        self::assertSame([], array_values($touching), 'Nothing lost a folder, so no message is looked at.');
    }

    public function testPresenceRangesRemoveEverythingNotListed(): void
    {
        $this->folders(['INBOX' => 1, 'Archive' => 1]);
        $this->messages('INBOX', [
            $this->message('10'), $this->message('11'), $this->message('12'),
            $this->message('25', ['messageId' => '<also-archived@x>']),
            $this->message('40'),
        ]);
        $this->messages('Archive', [$this->message('3', ['messageId' => '<also-archived@x>'])]);

        $result = $this->changes('INBOX', ['presence' => [
            ['fromUid' => 1, 'toUid' => 20, 'uids' => [10, 12]],
            ['fromUid' => 21, 'toUid' => 30, 'uids' => []],
        ]]);

        self::assertSame(['updated' => 0, 'removed' => 2, 'unknown' => 0, 'deleted' => 1, 'unknownUids' => []], $result);
        $remaining = array_map(static fn (MessageLocation $l): string => $l->getRemoteUid(), $this->entityManager()->getRepository(MessageLocation::class)->findBy(['folder' => $this->folderEntity('INBOX')], ['remoteUid' => 'ASC']));
        self::assertSame(['10', '12', '40'], $remaining, 'Uid 40 is outside every range and stays.');
        self::assertNotNull($this->entityManager()->getRepository(Message::class)->findOneBy(['messageIdHeader' => 'also-archived@x']));
    }

    public function testPresenceUidsMustLieInTheirRange(): void
    {
        $this->folders(['INBOX' => 1]);

        $this->client->jsonRequest('POST', $this->url('changes'), ['workerId' => 'w1', 'folder' => 'INBOX', 'presence' => [['fromUid' => 5, 'toUid' => 10, 'uids' => [4]]]], $this->worker);

        self::assertResponseStatusCodeSame(422);
    }

    public function testUnknownFolderIsRejected(): void
    {
        $this->folders(['INBOX' => 1]);

        $this->client->jsonRequest('POST', $this->url('messages'), ['workerId' => 'w1', 'folder' => 'Nope', 'messages' => [$this->message('1')]], $this->worker);

        self::assertResponseStatusCodeSame(422);
    }

    public function testInvalidMessageIsRejected(): void
    {
        $this->folders(['INBOX' => 1]);

        $this->client->jsonRequest('POST', $this->url('messages'), ['workerId' => 'w1', 'folder' => 'INBOX', 'messages' => [$this->message('1', ['rawObjectKey' => '../../etc/passwd'])]], $this->worker);

        self::assertResponseStatusCodeSame(422);
        self::assertStringContainsString('rawObjectKey', (string) $this->client->getResponse()->getContent());
    }

    public function testDuplicateFolderNamesAreRejected(): void
    {
        $this->client->jsonRequest('POST', $this->url('folders'), ['workerId' => 'w1', 'folders' => [
            ['remoteName' => 'INBOX', 'displayName' => 'Inbox', 'role' => 'inbox'],
            ['remoteName' => 'INBOX', 'displayName' => 'Inbox', 'role' => 'inbox'],
        ]], $this->worker);

        self::assertResponseStatusCodeSame(422);
    }

    public function testRequiresLease(): void
    {
        $this->client->jsonRequest('POST', $this->url('folders'), ['workerId' => 'w2', 'folders' => []], $this->worker);

        self::assertResponseStatusCodeSame(404);
    }

    public function testRequiresIngestScope(): void
    {
        $leaseOnly = $this->workerHeaders('sync:lease');

        $this->client->jsonRequest('POST', $this->url('folders'), ['workerId' => 'w1', 'folders' => []], $leaseOnly);

        self::assertResponseStatusCodeSame(403);
    }

    public function testStatusReportIsVisibleToTheUser(): void
    {
        $this->client->jsonRequest('POST', $this->url('status'), ['workerId' => 'w1', 'status' => 'auth_failed', 'detail' => 'The server rejected the password.'], $this->worker);
        self::assertResponseIsSuccessful();
        self::assertSame(['status' => 'auth_failed'], $this->decodedResponse());

        $user = $this->userHeaders('kim@example.test', ['settings:read']);
        $this->client->request('GET', '/api/v1/mail-accounts/'.$this->accountId, server: $user);
        $account = $this->decodedResponse();
        self::assertSame('auth_failed', $account['status'] ?? null);
        self::assertSame('The server rejected the password.', $account['statusDetail'] ?? null);
    }

    public function testPausingTakesTheLeaseAndAReportCannotUndoIt(): void
    {
        $patch = $this->userHeaders('kim@example.test', ['settings:write']) + ['CONTENT_TYPE' => 'application/merge-patch+json'];
        $this->client->request('PATCH', '/api/v1/mail-accounts/'.$this->accountId, server: $patch, content: '{"status":"paused"}');
        self::assertResponseIsSuccessful();

        $this->client->jsonRequest('POST', $this->url('status'), ['workerId' => 'w1', 'status' => 'active'], $this->worker);
        self::assertResponseStatusCodeSame(404, 'The worker no longer holds the account.');

        // A report that passed the lease check before the pause committed.
        $this->entityManager()->getConnection()->executeStatement(
            "UPDATE mail_account SET leased_by = 'w1', lease_expires_at = :until WHERE id = :id",
            ['until' => new \DateTimeImmutable('+1 minute', new \DateTimeZone('UTC'))->format('Y-m-d H:i:s'), 'id' => $this->accountId],
        );
        $this->client->jsonRequest('POST', $this->url('status'), ['workerId' => 'w1', 'status' => 'active'], $this->worker);
        self::assertResponseIsSuccessful();
        self::assertSame(['status' => 'paused'], $this->decodedResponse());
    }

    public function testAnActiveReportDoesNotUndoARefusedSignIn(): void
    {
        $this->entityManager()->getConnection()->executeStatement("UPDATE mail_account SET status = 'auth_failed', status_detail = 'Sign in again.' WHERE id = :id", ['id' => $this->accountId]);

        foreach (['active', 'error'] as $reported) {
            $this->client->jsonRequest('POST', $this->url('status'), ['workerId' => 'w1', 'status' => $reported, 'detail' => 'Connection lost.'], $this->worker);

            self::assertResponseIsSuccessful();
            self::assertSame(['status' => 'auth_failed'], $this->decodedResponse());
        }
    }

    public function testWorkerCannotPauseAnAccount(): void
    {
        $this->client->jsonRequest('POST', $this->url('status'), ['workerId' => 'w1', 'status' => 'paused'], $this->worker);

        self::assertResponseStatusCodeSame(422);
    }

    public function testFlagChangesNameTheMessagesTheApiDoesNotHave(): void
    {
        $this->folders(['INBOX' => 1]);
        $this->messages('INBOX', [$this->message('18c2a')]);

        $result = $this->changes('INBOX', ['flags' => [
            ['remoteUid' => '18c2a', 'flags' => ['seen' => true]],
            ['remoteUid' => '18c2b', 'flags' => ['seen' => true]],
            ['remoteUid' => '18c2b', 'flags' => ['seen' => false]],
            ['remoteUid' => '18c2c', 'flags' => ['flagged' => true]],
        ]]);

        self::assertSame(['updated' => 1, 'removed' => 0, 'unknown' => 2, 'deleted' => 0, 'unknownUids' => ['18c2b', '18c2c']], $result);
    }

    public function testRemoteUidsArePagedInByteOrder(): void
    {
        $this->folders(['INBOX' => 1, 'Archive' => 1]);
        $this->messages('INBOX', [$this->message('b'), $this->message('B'), $this->message('a'), $this->message('10'), $this->message('9')]);
        $this->messages('Archive', [$this->message('zz')]);

        $this->client->request('GET', $this->url('folders/remote-uids').'?'.http_build_query(['workerId' => 'w1', 'folder' => 'INBOX', 'limit' => 3]), server: $this->worker);
        self::assertResponseIsSuccessful();
        self::assertSame(['accountId' => $this->accountId, 'folder' => 'INBOX', 'remoteUids' => ['10', '9', 'B'], 'next' => 'B'], $this->decodedResponse());

        $this->client->request('GET', $this->url('folders/remote-uids').'?'.http_build_query(['workerId' => 'w1', 'folder' => 'INBOX', 'limit' => 3, 'after' => 'B']), server: $this->worker);
        self::assertSame(['a', 'b'], $this->decodedResponse()['remoteUids'] ?? null);
        self::assertArrayHasKey('next', $this->decodedResponse());
        self::assertNull($this->decodedResponse()['next']);
    }

    public function testRemoteUidsNeedALeaseAFolderAndASaneLimit(): void
    {
        $this->folders(['INBOX' => 1]);

        $this->client->request('GET', $this->url('folders/remote-uids').'?'.http_build_query(['workerId' => 'w2', 'folder' => 'INBOX']), server: $this->worker);
        self::assertResponseStatusCodeSame(404);

        $this->client->request('GET', $this->url('folders/remote-uids').'?'.http_build_query(['workerId' => 'w1']), server: $this->worker);
        self::assertResponseStatusCodeSame(400);

        $this->client->request('GET', $this->url('folders/remote-uids').'?'.http_build_query(['workerId' => 'w1', 'folder' => 'INBOX', 'limit' => 5001]), server: $this->worker);
        self::assertResponseStatusCodeSame(400);

        $this->client->request('GET', $this->url('folders/remote-uids').'?'.http_build_query(['workerId' => 'w1', 'folder' => 'Nope']), server: $this->worker);
        self::assertResponseStatusCodeSame(422);
    }

    /**
     * @param array<string, int> $folders remote name => UIDVALIDITY
     *
     * @return list<array<string, mixed>>
     */
    private function folders(array $folders): array
    {
        $payload = [];
        foreach ($folders as $name => $uidValidity) {
            $payload[] = ['remoteName' => $name, 'displayName' => $name, 'role' => 'INBOX' === $name ? 'inbox' : 'custom', 'uidValidity' => $uidValidity];
        }
        $this->client->jsonRequest('POST', $this->url('folders'), ['workerId' => 'w1', 'folders' => $payload], $this->worker);
        self::assertResponseIsSuccessful();

        /** @var list<array<string, mixed>> */
        return $this->decodedResponse()['folders'] ?? [];
    }

    /**
     * @param list<array<string, mixed>> $messages
     *
     * @return array<mixed>
     */
    private function messages(string $folder, array $messages, ?string $cursor = null): array
    {
        $this->client->jsonRequest('POST', $this->url('messages'), ['workerId' => 'w1', 'folder' => $folder, 'cursor' => $cursor, 'messages' => $messages], $this->worker);
        self::assertResponseIsSuccessful();

        return $this->decodedResponse();
    }

    /**
     * @param array<string, mixed> $changes
     *
     * @return array<mixed>
     */
    private function changes(string $folder, array $changes): array
    {
        $this->client->jsonRequest('POST', $this->url('changes'), ['workerId' => 'w1', 'folder' => $folder] + $changes, $this->worker);
        self::assertResponseIsSuccessful();

        return $this->decodedResponse();
    }

    /**
     * @param array<string, mixed> $override
     *
     * @return array<string, mixed>
     */
    private function message(string $uid, array $override = []): array
    {
        // Copies of one mail (one Message-ID) have the same content, as on a real server.
        $messageId = $override['messageId'] ?? null;

        return $override + [
            'remoteUid' => $uid,
            'modSeq' => 1,
            'rawObjectKey' => $this->rawKeyFor($this->accountId, \is_string($messageId) ? 'message-'.trim($messageId, '<>') : 'message-'.$uid.'-'.json_encode($override)),
            'keyVersion' => 1,
            'size' => 2048,
            'receivedAt' => '2026-10-19T08:00:00+00:00',
            'sentAt' => '2026-10-19T07:59:00+00:00',
            'flags' => ['seen' => false, 'flagged' => false, 'answered' => false, 'draft' => false],
            'messageId' => '<msg-'.$uid.'@test.example>',
            'subject' => 'Message '.$uid,
            'from' => ['address' => 'sender@test.example', 'name' => 'Sender'],
            'to' => [['address' => 'kim@company.example']],
            'snippet' => 'Hello',
        ];
    }

    private function url(string $action): string
    {
        return '/internal/sync/accounts/'.$this->accountId.'/'.$action;
    }

    /**
     * @param class-string $class
     */
    private function rows(string $class): int
    {
        return $this->entityManager()->getRepository($class)->count([]);
    }

    private function folderEntity(string $remoteName): Folder
    {
        $folder = $this->entityManager()->getRepository(Folder::class)->findOneBy(['remoteName' => $remoteName]);
        self::assertInstanceOf(Folder::class, $folder);

        return $folder;
    }

    private function onlyMessage(): Message
    {
        $messages = $this->entityManager()->getRepository(Message::class)->findAll();
        self::assertCount(1, $messages);

        return $messages[0];
    }

    private function onlyThread(): Thread
    {
        $threads = $this->entityManager()->getRepository(Thread::class)->findAll();
        self::assertCount(1, $threads);

        return $threads[0];
    }

    private function entityManager(): EntityManagerInterface
    {
        $entityManager = static::getContainer()->get(EntityManagerInterface::class);
        $entityManager->clear();

        return $entityManager;
    }
}
