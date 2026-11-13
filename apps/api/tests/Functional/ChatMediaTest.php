<?php

declare(strict_types=1);

namespace App\Tests\Functional;

use App\Account\PurgeDeletedUser;
use App\Account\PurgeDeletedUserHandler;
use App\Chat\ChatFileBody;
use App\Chat\ChatMediaUrls;
use App\Chat\ChatUploads;
use App\Chat\CollectChatMedia;
use App\Command\RescanAttachmentsCommand;
use App\Entity\Attachment;
use App\Entity\ChatMessage;
use App\Scan\AttachmentAccess;
use App\Scan\DownloadPolicy;
use App\Scan\SweepPendingScans;
use App\Scan\SweepPendingScansHandler;
use App\Security\Crypto\UserKeys;
use App\Storage\BlobKind;
use App\Storage\BlobVault;
use App\Storage\Reencryption;
use App\Tests\Support\FakeVirusScanner;
use App\Tests\Support\InMemoryObjectStorage;
use Doctrine\ORM\EntityManagerInterface;
use Symfony\Bundle\FrameworkBundle\Console\Application;
use Symfony\Component\Console\Tester\CommandTester;
use Symfony\Component\HttpFoundation\UriSigner;
use Symfony\Component\Messenger\Envelope;
use Symfony\Component\Messenger\MessageBusInterface;
use Symfony\Component\Messenger\Stamp\ReceivedStamp;
use Symfony\Component\Messenger\Transport\InMemory\InMemoryTransport;
use Symfony\Component\Routing\Generator\UrlGeneratorInterface;
use Symfony\Component\Uid\Uuid;

/**
 * WhatsApp files through the relay ("All my devices"). A file stays on Kim's Mac until she asks for it on another
 * device; then the Mac brings it, the server keeps it sealed with her key and scans it before anyone downloads it. A
 * file she attaches to a reply in the browser or on her phone waits on the server until the Mac sent the reply, then
 * goes. The test environment takes files up to 4096 bytes.
 */
final class ChatMediaTest extends DatabaseTestCase
{
    use AuthenticatesUsers;
    use ConnectsThirdPartyApps;
    use RelaysChats;
    use RunsScans;
    use SeedsAccessTokens;
    use StoresChats;

    private const string PHOTO = "\xFF\xD8\xFF\xE0 a photo of the drill";

    private string $chatId;

    private string $photoId;

    private string $textId;

    protected function setUp(): void
    {
        parent::setUp();
        $this->setUpRelay();
        $this->relayMessages([
            self::waMessage('M1', 'Can you bring the drill on Saturday?'),
            self::waMessage('M2', '', '2026-11-12T09:15:00+00:00', ['media' => ['kind' => 'image', 'name' => '../../Photos/drill.jpg', 'size' => \strlen(self::PHOTO)]]),
        ]);
        $this->chatId = $this->chatId();
        $this->photoId = $this->messageId('M2');
        $this->textId = $this->messageId('M1');
    }

    public function testAFileStaysOnTheMacUntilAskedFor(): void
    {
        $photo = $this->deltaMessage('M2');
        self::assertSame(['remote', null, null], [$photo['mediaState'], $photo['mediaError'], $photo['mediaAccess']]);
        $text = $this->deltaMessage('M1');
        self::assertSame([null, null, null], [$text['mediaState'], $text['mediaError'], $text['mediaAccess']]);

        $this->relay('media/claim');
        self::assertResponseStatusCodeSame(204, 'Nobody asked for anything.');
    }

    public function testAskingForAFileHandsItToTheRelay(): void
    {
        $cursor = $this->delta(0)['cursor'];

        $this->requestMedia($this->photoId);

        self::assertResponseStatusCodeSame(200);
        self::assertSame(['messageId' => $this->photoId, 'kind' => 'image', 'name' => '../../Photos/drill.jpg', 'size' => \strlen(self::PHOTO), 'state' => 'requested', 'error' => null, 'access' => null, 'url' => null], $this->decodedResponse());
        $changed = $this->delta($cursor)['chatMessages'];
        self::assertSame([$this->photoId], array_column($changed, 'id'), 'Every device learns that it was asked for.');
        self::assertSame('requested', $changed[0]['mediaState']);

        $this->requestMedia($this->photoId);
        self::assertResponseStatusCodeSame(200, 'Asking again changes nothing.');

        $this->relay('media/claim');
        self::assertResponseStatusCodeSame(200);
        self::assertSame(['messageId' => $this->photoId, 'chatJid' => self::JID, 'waId' => 'M2', 'kind' => 'image', 'size' => \strlen(self::PHOTO), 'maxBytes' => 4096], $this->decodedResponse());

        $this->relay('media/claim');
        self::assertResponseStatusCodeSame(204, 'A request the relay holds is not handed out twice.');
    }

    public function testOnlyTheOwnersOwnAppsAskForAFile(): void
    {
        $this->requestMedia($this->textId);
        self::assertResponseStatusCodeSame(404, 'A message without a file.');

        $this->requestMedia($this->photoId, $this->userHeaders('lisa@example.test', ['mail:read', 'mail:write', 'mail:send']));
        self::assertResponseStatusCodeSame(404, 'Another user\'s message is not found.');

        $this->requestMedia($this->photoId, $this->seededThirdPartyHeaders('kim@example.test', ['chat:read', 'chat:send']));
        self::assertResponseStatusCodeSame(403, 'An app that is not ours never makes the Mac download anything.');
        $this->requestMedia($this->photoId, $this->personalAccessTokenHeaders('kim@example.test', ['chat:read']));
        self::assertResponseStatusCodeSame(403);

        self::assertSame('remote', $this->deltaMessage('M2')['mediaState']);
    }

    public function testTheRelayBringsTheFileSealedAndScannedBeforeItIsServed(): void
    {
        $this->requestMedia($this->photoId);
        $this->relay('media/claim');
        $cursor = $this->delta(0)['cursor'];

        $this->upload($this->photoId, self::PHOTO);

        self::assertResponseStatusCodeSame(200);
        self::assertSame(['messageId' => $this->photoId, 'state' => 'stored', 'error' => null], $this->decodedResponse());
        $key = $this->objectKey($this->photoId);
        self::assertStringStartsWith(BlobKind::ChatMedia->value.'/', $key);
        self::assertStringNotContainsString('drill', $this->storage()->read($key), 'Stored sealed.');
        self::assertSame(self::PHOTO, static::getContainer()->get(BlobVault::class)->read($this->kimsId(), $key));
        self::assertSame('pending', $this->connection()->fetchOne('SELECT media_scan_status FROM chat_message WHERE id = :id', ['id' => $this->photoId]));

        // Right after the upload: the test client empties the queues with its next request.
        $this->runQueuedScans();
        $after = $this->delta($cursor)['chatMessages'];
        self::assertSame(['stored', 'allowed'], [$after[0]['mediaState'] ?? null, $after[0]['mediaAccess'] ?? null], 'Every device learns the verdict.');

        $this->client->request('GET', '/api/v1/chat-messages/'.$this->photoId.'/media', server: $this->web);
        self::assertResponseIsSuccessful();
        $media = $this->decodedResponse();
        self::assertSame(['stored', 'allowed'], [$media['state'], $media['access']]);
        self::assertIsString($media['url']);

        $this->client->request('GET', $media['url']);
        self::assertResponseIsSuccessful();
        self::assertSame(self::PHOTO, (string) $this->client->getInternalResponse()->getContent());
        $disposition = (string) $this->client->getResponse()->headers->get('Content-Disposition');
        self::assertStringContainsString('drill.jpg', $disposition);
        self::assertStringNotContainsString('Photos', $disposition, 'The sender\'s folder never comes along.');
        self::assertSame('nosniff', $this->client->getResponse()->headers->get('X-Content-Type-Options'));
        self::assertStringContainsString('sandbox', (string) $this->client->getResponse()->headers->get('Content-Security-Policy'));

        $this->client->request('GET', $media['url'].'x');
        self::assertResponseStatusCodeSame(403, 'A link that was changed is refused.');
        $this->client->request('GET', '/api/v1/chat-messages/'.$this->photoId.'/media', server: $this->userHeaders('lisa@example.test', ['mail:read']));
        self::assertResponseStatusCodeSame(404);
    }

    public function testTheSameFileAgainChangesNothing(): void
    {
        $this->requestMedia($this->photoId);
        $this->relay('media/claim');
        $this->upload($this->photoId, self::PHOTO);
        self::assertSame('scanning', $this->deltaMessage('M2')['mediaAccess'], 'Stored, not scanned yet.');
        $this->client->request('GET', '/api/v1/chat-messages/'.$this->photoId.'/media', server: $this->web);
        self::assertResponseIsSuccessful();
        self::assertSame(['stored', 'scanning', null], [$this->decodedResponse()['state'], $this->decodedResponse()['access'], $this->decodedResponse()['url']], 'No link before the scan.');
        $seq = $this->kimsChangeSeq();

        $this->upload($this->photoId, self::PHOTO);

        self::assertResponseStatusCodeSame(200);
        self::assertSame('stored', $this->decodedResponse()['state'] ?? null);
        self::assertSame($seq, $this->kimsChangeSeq());
    }

    public function testAnUploadMustBeWhatTheBridgeStored(): void
    {
        $this->requestMedia($this->photoId);
        $this->relay('media/claim');

        $this->upload($this->photoId, self::PHOTO, hash('sha256', 'something else'));
        self::assertResponseStatusCodeSame(422);
        $this->upload($this->photoId, self::PHOTO, '');
        self::assertResponseStatusCodeSame(422, 'The relay always names the SHA-256.');
        $this->upload($this->photoId, '');
        self::assertResponseStatusCodeSame(422, 'An empty file.');
        $this->upload($this->photoId, str_repeat('x', 4097));
        self::assertResponseStatusCodeSame(413);
        self::assertSame('too_large', $this->decodedResponse()['code'] ?? null);

        self::assertSame('requested', $this->deltaMessage('M2')['mediaState']);
        $this->runCollections();
        self::assertSame([], $this->chatObjects(), 'Nothing that arrived is kept.');
    }

    public function testOnlyTheRelayBringsFilesAndOnlyThoseAskedFor(): void
    {
        $this->upload($this->photoId, self::PHOTO);
        self::assertResponseStatusCodeSame(409, 'Nobody asked for it.');
        self::assertSame('not_requested', $this->decodedResponse()['code'] ?? null);

        $this->requestMedia($this->photoId);
        $this->upload($this->photoId, self::PHOTO, deviceId: self::OTHER_MAC);
        self::assertResponseStatusCodeSame(409);
        self::assertSame('not_the_relay', $this->decodedResponse()['code'] ?? null);
        $this->upload($this->photoId, self::PHOTO, headers: $this->web);
        self::assertResponseStatusCodeSame(403, 'Only the desktop app relays.');
        $this->upload($this->textId, self::PHOTO);
        self::assertResponseStatusCodeSame(404, 'A message without a file.');
        $this->relay('media/claim', headers: $this->web);
        self::assertResponseStatusCodeSame(403);

        $this->runCollections();
        self::assertSame([], $this->chatObjects());
    }

    public function testAFailureIsShownAndTheUserMayAskAgain(): void
    {
        $this->requestMedia($this->photoId);
        $this->relay('media/claim');

        $this->relay('media/'.$this->photoId.'/failed', ['error' => 'unavailable']);
        self::assertResponseStatusCodeSame(200);
        self::assertSame(['messageId' => $this->photoId, 'state' => 'failed', 'error' => 'unavailable'], $this->decodedResponse());
        self::assertSame(['failed', 'unavailable'], [$this->deltaMessage('M2')['mediaState'], $this->deltaMessage('M2')['mediaError']]);

        $this->relay('media/'.$this->photoId.'/failed', ['error' => 'unavailable']);
        self::assertResponseStatusCodeSame(200, 'The same failure again.');
        $this->relay('media/'.$this->photoId.'/failed', ['error' => 'mismatch']);
        self::assertResponseStatusCodeSame(409);
        $this->relay('media/'.$this->photoId.'/failed', ['error' => 'lost']);
        self::assertContains($this->client->getResponse()->getStatusCode(), [400, 422], 'A reason the server does not know.');
        $this->relay('media/'.$this->photoId.'/failed', []);
        self::assertResponseStatusCodeSame(422);

        $this->requestMedia($this->photoId);
        self::assertSame(['requested', null], [$this->decodedResponse()['state'], $this->decodedResponse()['error']]);
        $this->relay('media/claim');
        self::assertResponseStatusCodeSame(200, 'Asked again, the relay tries again.');
    }

    public function testAnInfectedFileIsNeverServed(): void
    {
        $this->requestMedia($this->photoId);
        $this->relay('media/claim');
        $this->upload($this->photoId, FakeVirusScanner::EICAR);
        $key = $this->objectKey($this->photoId);
        $this->runQueuedScans();

        self::assertSame('blocked', $this->deltaMessage('M2')['mediaAccess']);
        $this->client->request('GET', '/api/v1/chat-messages/'.$this->photoId.'/media', server: $this->web);
        self::assertNull($this->decodedResponse()['url']);
        $this->client->jsonRequest('POST', '/api/v1/chat-messages/'.$this->photoId.'/media/unscanned-link', ['confirmed' => true], $this->web);
        self::assertResponseStatusCodeSame(403);
        self::assertFalse($this->storage()->has($key), 'Moved to quarantine.');
    }

    public function testAFileThatCouldNotBeScannedNeedsTheUsersWord(): void
    {
        $this->requestMedia($this->photoId);
        $this->relay('media/claim');
        $this->scanner()->maxSize = 8;
        $this->upload($this->photoId, self::PHOTO);
        $this->runQueuedScans();

        self::assertSame('confirm', $this->deltaMessage('M2')['mediaAccess']);
        $this->client->jsonRequest('POST', '/api/v1/chat-messages/'.$this->photoId.'/media/unscanned-link', [], $this->web);
        self::assertResponseStatusCodeSame(422);
        $this->client->jsonRequest('POST', '/api/v1/chat-messages/'.$this->photoId.'/media/unscanned-link', ['confirmed' => true], $this->seededThirdPartyHeaders('kim@example.test', ['chat:read']));
        self::assertResponseStatusCodeSame(403, 'Only in our own apps, where the user sees the warning.');
        $this->client->jsonRequest('POST', '/api/v1/chat-messages/'.$this->photoId.'/media/unscanned-link', ['confirmed' => true], $this->web);
        self::assertResponseIsSuccessful();
        $url = $this->decodedResponse()['url'] ?? null;
        self::assertIsString($url);

        $this->client->request('GET', $url);
        self::assertResponseIsSuccessful();
        self::assertSame(self::PHOTO, (string) $this->client->getInternalResponse()->getContent());
    }

    public function testAReplyCarriesAFileTheRelayFetchesAndTheFileGoesOnceSent(): void
    {
        $uploadId = Uuid::v7()->toRfc4122();
        $this->uploadForReply($uploadId, '%PDF-1.4 the drill manual');
        self::assertResponseStatusCodeSame(201);
        self::assertSame(['id' => $uploadId, 'chatId' => $this->chatId, 'size' => 25], array_intersect_key($this->decodedResponse(), ['id' => 0, 'chatId' => 0, 'size' => 0]));
        $this->uploadForReply($uploadId, '%PDF-1.4 the drill manual');
        self::assertResponseStatusCodeSame(200, 'The same upload again.');
        $this->uploadForReply($uploadId, 'other content');
        self::assertResponseStatusCodeSame(409);
        self::assertSame('id_taken', $this->decodedResponse()['code'] ?? null);

        $replyId = self::newReplyId();
        $this->client->jsonRequest('POST', '/api/v1/chats/'.$this->chatId.'/outgoing', ['id' => $replyId, 'text' => '', 'file' => ['uploadId' => $uploadId, 'name' => 'C:\\Users\\kim\\Drill manual.pdf']], $this->web);
        self::assertResponseStatusCodeSame(201);
        self::assertSame(['name' => 'Drill manual.pdf', 'size' => 25], $this->decodedResponse()['file'] ?? null);
        self::assertSame(0, $this->countRows('SELECT COUNT(*) FROM chat_upload'), 'The reply took the upload over.');
        $sealed = $this->connection()->fetchOne('SELECT sealed_file_name FROM chat_outgoing WHERE id = :id', ['id' => $replyId]);
        self::assertIsString($sealed);
        self::assertStringNotContainsString('Drill', $sealed);

        $this->relay('outgoing/claim');
        self::assertResponseStatusCodeSame(200);
        $claim = $this->decodedResponse();
        $file = $claim['file'] ?? null;
        self::assertIsArray($file);
        self::assertSame(['Drill manual.pdf', 25], [$file['name'] ?? null, $file['size'] ?? null]);
        self::assertIsString($file['url'] ?? null);
        $this->client->request('GET', $file['url']);
        self::assertResponseIsSuccessful();
        self::assertSame('%PDF-1.4 the drill manual', (string) $this->client->getInternalResponse()->getContent());
        self::assertSame('application/octet-stream', $this->client->getResponse()->headers->get('Content-Type'));
        $key = $this->connection()->fetchOne('SELECT file_object_key FROM chat_outgoing WHERE id = :id', ['id' => $replyId]);
        self::assertIsString($key);

        $this->report($replyId, ['sent' => true]);
        self::assertResponseIsSuccessful();
        $this->runCollections();

        self::assertFalse($this->storage()->has($key), 'Sent: the file is no longer kept.');
        self::assertSame(['name' => 'Drill manual.pdf', 'size' => 25], $this->delta(0)['chatOutgoing'][0]['file'] ?? null, 'Its name and size stay as the record.');
        $this->client->request('GET', $file['url']);
        self::assertResponseStatusCodeSame(404, 'Only while the reply is being sent.');
    }

    public function testACancelledReplyTakesItsFileAlong(): void
    {
        $uploadId = Uuid::v7()->toRfc4122();
        $this->uploadForReply($uploadId, '%PDF-1.4 cancelled');
        $replyId = self::newReplyId();
        $this->client->jsonRequest('POST', '/api/v1/chats/'.$this->chatId.'/outgoing', ['id' => $replyId, 'text' => 'The manual', 'file' => ['uploadId' => $uploadId, 'name' => 'manual.pdf']], $this->web);
        self::assertResponseStatusCodeSame(201);
        self::assertCount(1, $this->chatObjects());

        $this->client->request('DELETE', '/api/v1/chat-outgoing/'.$replyId, server: $this->web);
        self::assertResponseStatusCodeSame(204);
        $this->runCollections();

        self::assertSame([], $this->chatObjects());
    }

    public function testOnlyOurOwnAppsAttachFiles(): void
    {
        $tool = $this->seededThirdPartyHeaders('kim@example.test', ['chat:read', 'chat:send']);
        $this->uploadForReply(Uuid::v7()->toRfc4122(), 'from a tool', $tool);
        self::assertResponseStatusCodeSame(403);

        $uploadId = Uuid::v7()->toRfc4122();
        $this->uploadForReply($uploadId, 'from the web app');
        $this->client->jsonRequest('POST', '/api/v1/chats/'.$this->chatId.'/outgoing', ['id' => self::newReplyId(), 'text' => 'Here', 'file' => ['uploadId' => $uploadId, 'name' => 'a.txt']], $tool);
        self::assertResponseStatusCodeSame(403);

        $this->uploadForReply(Uuid::v7()->toRfc4122(), 'Lisa\'s', $this->userHeaders('lisa@example.test', ['mail:read', 'mail:write', 'mail:send']));
        self::assertResponseStatusCodeSame(404, 'Another user\'s chat.');
        $this->uploadForReply('not-a-uuid', 'x');
        self::assertResponseStatusCodeSame(422);
        $this->uploadForReply(Uuid::v7()->toRfc4122(), str_repeat('x', 4097));
        self::assertResponseStatusCodeSame(413);
    }

    public function testAReplyNeedsTextOrAnUploadOfItsChat(): void
    {
        $this->client->jsonRequest('POST', '/api/v1/chats/'.$this->chatId.'/outgoing', ['id' => self::newReplyId(), 'text' => '  '], $this->web);
        self::assertResponseStatusCodeSame(422);
        self::assertSame(['text'], $this->violationPaths());

        $this->client->jsonRequest('POST', '/api/v1/chats/'.$this->chatId.'/outgoing', ['id' => self::newReplyId(), 'text' => '', 'file' => ['uploadId' => Uuid::v7()->toRfc4122(), 'name' => 'gone.pdf']], $this->web);
        self::assertResponseStatusCodeSame(422);
        self::assertSame(['file.uploadId'], $this->violationPaths());

        $this->client->jsonRequest('POST', '/api/v1/chats/'.$this->chatId.'/outgoing', ['id' => self::newReplyId(), 'text' => 'x', 'file' => ['uploadId' => Uuid::v7()->toRfc4122(), 'name' => "a\u{0007}.pdf"]], $this->web);
        self::assertResponseStatusCodeSame(422);
        self::assertSame(['file.name'], $this->violationPaths());
    }

    public function testAChatLeftOutTakesItsFilesAlong(): void
    {
        $this->requestMedia($this->photoId);
        $this->relay('media/claim');
        $this->upload($this->photoId, self::PHOTO);
        $this->uploadForReply(Uuid::v7()->toRfc4122(), 'waiting upload');
        self::assertCount(2, $this->chatObjects());

        $this->client->request('PATCH', '/api/v1/chats/'.$this->chatId, [], [], ['CONTENT_TYPE' => 'application/merge-patch+json'] + $this->web, (string) json_encode(['leftOut' => true]));
        self::assertResponseIsSuccessful();
        $this->runCollections();

        self::assertSame([], $this->chatObjects());
        self::assertSame(0, $this->countRows('SELECT COUNT(*) FROM chat_upload'));
        $this->uploadForReply(Uuid::v7()->toRfc4122(), 'more');
        self::assertResponseStatusCodeSame(422, 'Nothing is sent to a chat left out.');
    }

    public function testRemovingTheAccountTakesEveryFileAlong(): void
    {
        $this->requestMedia($this->photoId);
        $this->relay('media/claim');
        $this->upload($this->photoId, self::PHOTO);
        $this->uploadForReply(Uuid::v7()->toRfc4122(), 'waiting upload');

        $this->client->request('DELETE', '/api/v1/chat-accounts/'.$this->accountId, server: $this->desktop);
        self::assertResponseStatusCodeSame(204);
        $this->runCollections();

        self::assertSame([], $this->chatObjects());
    }

    public function testAnUploadNobodyQueuedGoesAfterAnHour(): void
    {
        $this->uploadForReply(Uuid::v7()->toRfc4122(), 'forgotten');
        $this->uploadForReply(Uuid::v7()->toRfc4122(), 'recent');
        $this->connection()->executeStatement("UPDATE chat_upload SET created_at = created_at - INTERVAL '2 hours' WHERE size = 9");

        self::assertSame(1, static::getContainer()->get(ChatUploads::class)->sweep(new \DateTimeImmutable()));
        $this->runCollections();

        self::assertSame(1, $this->countRows('SELECT COUNT(*) FROM chat_upload'));
        self::assertCount(1, $this->chatObjects());
    }

    public function testAFileSharedByTwoMessagesStaysUntilBothLetGo(): void
    {
        $this->relayMessages([self::waMessage('M3', '', '2026-11-12T09:16:00+00:00', ['media' => ['kind' => 'image', 'name' => 'again.jpg', 'size' => null]])]);
        $again = $this->messageId('M3');
        foreach ([$this->photoId, $again] as $id) {
            $this->requestMedia($id);
            $this->relay('media/claim');
            $this->upload($id, self::PHOTO);
        }
        self::assertCount(1, $this->chatObjects(), 'One object for one content.');
        $uploadId = Uuid::v7()->toRfc4122();
        $this->uploadForReply($uploadId, self::PHOTO);
        $replyId = self::newReplyId();
        $this->client->jsonRequest('POST', '/api/v1/chats/'.$this->chatId.'/outgoing', ['id' => $replyId, 'text' => 'Same photo', 'file' => ['uploadId' => $uploadId, 'name' => 'drill.jpg']], $this->web);
        $this->client->request('DELETE', '/api/v1/chat-outgoing/'.$replyId, server: $this->web);
        $this->runCollections();

        self::assertCount(1, $this->chatObjects(), 'The messages still refer to it.');
    }

    public function testFilesAreForOurOwnAppsOnly(): void
    {
        $this->storePhoto();

        foreach ([$this->seededThirdPartyHeaders('kim@example.test', ['chat:read']), $this->personalAccessTokenHeaders('kim@example.test', ['chat:read'])] as $headers) {
            $this->client->request('GET', '/api/v1/chat-messages/'.$this->photoId.'/media', server: $headers);
            self::assertResponseIsSuccessful();
            $media = $this->decodedResponse();
            self::assertSame(['stored', 'allowed', null], [$media['state'], $media['access'], $media['url']], 'Where it stands, never a link.');
        }
        $this->client->request('GET', '/api/v1/chat-messages/'.$this->photoId.'/media', server: $this->web);
        self::assertIsString($this->decodedResponse()['url'] ?? null);
    }

    public function testAContentLinkWaitsForTheScanAndAnswersALaterVerdict(): void
    {
        $this->requestMedia($this->photoId);
        $this->relay('media/claim');
        $this->upload($this->photoId, self::PHOTO);
        $scans = $this->takeScans();
        $link = static::getContainer()->get(UriSigner::class)->sign('http://localhost/content/chat-media/'.$this->photoId, new \DateInterval('PT1H'));

        $this->client->request('GET', $link);
        self::assertResponseStatusCodeSame(409, 'Still being scanned.');

        $this->runScans($scans);
        $this->client->request('GET', $link);
        self::assertResponseIsSuccessful();

        $this->scanner()->alsoInfected = [self::PHOTO];
        $tester = new CommandTester(new Application($this->client->getKernel())->find('app:attachments:rescan'));
        $tester->execute(['--all' => true]);
        $tester->assertCommandIsSuccessful();
        $this->runScans($this->takeScans(RescanAttachmentsCommand::TRANSPORT));

        self::assertSame('infected', $this->connection()->fetchOne('SELECT media_scan_status FROM chat_message WHERE id = :id', ['id' => $this->photoId]), 'The rescan covers chat files.');
        $this->client->request('GET', $link);
        self::assertResponseStatusCodeSame(403, 'A link given before is refused after the verdict.');
    }

    public function testAServerThatRequiresScansNeverLinksAFileThatCouldNotBeScanned(): void
    {
        $this->requestMedia($this->photoId);
        $this->relay('media/claim');
        $this->scanner()->maxSize = 8;
        $this->upload($this->photoId, self::PHOTO);
        $this->runQueuedScans();
        $message = $this->chatEntityManager()->find(ChatMessage::class, Uuid::fromString($this->photoId));
        self::assertInstanceOf(ChatMessage::class, $message);

        $strict = new ChatMediaUrls(static::getContainer()->get(UrlGeneratorInterface::class), static::getContainer()->get(UriSigner::class), new DownloadPolicy(true));

        self::assertSame(AttachmentAccess::Blocked, $strict->access($message));
        self::assertNull($strict->forMessage($message, true));
        $lenient = static::getContainer()->get(ChatMediaUrls::class);
        self::assertSame(AttachmentAccess::Confirm, $lenient->access($message));
        self::assertIsString($lenient->forMessage($message, true));
    }

    public function testTheScanSweepQueuesAChatFileWhoseScanGotLost(): void
    {
        $this->requestMedia($this->photoId);
        $this->relay('media/claim');
        $this->upload($this->photoId, self::PHOTO);
        $this->takeScans();
        $this->connection()->executeStatement("UPDATE chat_message SET media_scan_requested_at = NOW() - INTERVAL '1 hour' WHERE id = :id", ['id' => $this->photoId]);

        static::getContainer()->get(SweepPendingScansHandler::class)(new SweepPendingScans());
        $this->runScans($this->takeScans());

        self::assertSame('clean', $this->connection()->fetchOne('SELECT media_scan_status FROM chat_message WHERE id = :id', ['id' => $this->photoId]));
    }

    public function testRotationWritesStoredAndQuarantinedFilesAgain(): void
    {
        $this->relayMessages([self::waMessage('M3', '', '2026-11-12T09:16:00+00:00', ['media' => ['kind' => 'document', 'name' => 'bad.exe', 'size' => null]])]);
        $bad = $this->messageId('M3');
        $this->storePhoto();
        $this->requestMedia($bad);
        $this->relay('media/claim');
        $this->upload($bad, FakeVirusScanner::EICAR);
        $this->runQueuedScans();
        $kim = $this->kimsId();
        $fingerprint = $this->connection()->fetchOne('SELECT media_sha256 FROM chat_message WHERE id = :id', ['id' => $bad]);
        self::assertIsString($fingerprint);
        $quarantined = Attachment::quarantineKey($fingerprint, $kim);
        self::assertTrue($this->storage()->has($quarantined));

        $tester = new CommandTester(new Application($this->client->getKernel())->find('app:crypto:rotate-user-keys'));
        $tester->execute(['--user' => ['kim@example.test']]);
        $tester->assertCommandIsSuccessful();
        static::getContainer()->get(UserKeys::class)->reset();
        $reencryption = static::getContainer()->get(Reencryption::class);
        self::assertSame(2, $reencryption->remaining($kim)['chatMedia']);

        $result = $reencryption->run($kim, 10, static function (): void {});

        self::assertSame(0, $result->failed);
        self::assertSame(0, $reencryption->remaining($kim)['chatMedia']);
        self::assertSame(2, $this->countRows('SELECT COUNT(*) FROM chat_message WHERE media_key_version = 2'));
        $blobs = static::getContainer()->get(BlobVault::class);
        self::assertSame(self::PHOTO, $blobs->read($kim, $this->objectKey($this->photoId)));
        self::assertSame(FakeVirusScanner::EICAR, $blobs->read($kim, $quarantined), 'Rewritten where it is: in quarantine.');
    }

    public function testDeletingTheUserRemovesTheirFiles(): void
    {
        $this->storePhoto();
        $this->uploadForReply(Uuid::v7()->toRfc4122(), 'waiting upload');
        self::assertCount(2, $this->chatObjects());

        static::getContainer()->get(PurgeDeletedUserHandler::class)(new PurgeDeletedUser($this->kimsId()->toRfc4122()));

        self::assertSame([], $this->chatObjects());
    }

    public function testTakingGroupsOffTheServerTakesTheirFiles(): void
    {
        $this->relayMessages(
            [self::waMessage('G1', '', '2026-11-12T09:20:00+00:00', ['chatJid' => self::GROUP_JID, 'sender' => ['id' => '31611111111', 'name' => 'Mom'], 'media' => ['kind' => 'image', 'name' => 'family.jpg', 'size' => null]])],
            [['jid' => self::GROUP_JID, 'name' => 'Family', 'kind' => 'group']],
        );
        $groupPhoto = $this->messageId('G1');
        $this->requestMedia($groupPhoto);
        $this->relay('media/claim');
        $this->upload($groupPhoto, 'a group photo');
        $this->storePhoto();
        self::assertCount(2, $this->chatObjects());

        $this->client->request('PATCH', '/api/v1/chat-accounts/'.$this->accountId, [], [], ['CONTENT_TYPE' => 'application/merge-patch+json'] + $this->desktop, '{"includeGroups":false}');
        self::assertResponseIsSuccessful();
        $this->runCollections();

        self::assertSame([$this->objectKey($this->photoId)], $this->chatObjects(), 'The direct chat keeps its file.');
    }

    public function testAFailedFileReplyIsTriedAgainWithItsFile(): void
    {
        $replyId = $this->queueFileReply('%PDF-1.4 again');
        $this->relay('outgoing/claim');
        $this->report($replyId, ['sent' => false, 'error' => 'refused']);
        self::assertResponseIsSuccessful();

        $this->client->jsonRequest('POST', '/api/v1/chat-outgoing/'.$replyId.'/retry', [], $this->web);
        self::assertResponseIsSuccessful();
        $this->relay('outgoing/claim');
        $file = $this->decodedResponse()['file'] ?? null;
        self::assertIsArray($file);
        self::assertIsString($file['url'] ?? null);
        $this->client->request('GET', $file['url']);
        self::assertSame('%PDF-1.4 again', (string) $this->client->getInternalResponse()->getContent());
    }

    public function testAReplyWithAFileHasALongerLease(): void
    {
        $fileReply = $this->queueFileReply('%PDF-1.4 slow');
        $this->relay('outgoing/claim');
        $textReply = $this->queueReply($this->chatId, 'A text')['id'] ?? null;
        self::assertIsString($textReply);
        $this->relay('outgoing/claim');
        $this->connection()->executeStatement("UPDATE chat_outgoing SET claimed_at = NOW() - INTERVAL '10 minutes'");

        $this->sweep();

        self::assertSame(['failed', 'sending'], [$this->statusOf($textReply), $this->statusOf($fileReply)], 'A text is unconfirmed after 5 minutes, a file is still on its way.');

        $this->connection()->executeStatement("UPDATE chat_outgoing SET claimed_at = NOW() - INTERVAL '31 minutes' WHERE id = :id", ['id' => $fileReply]);
        $this->sweep();
        self::assertSame('failed', $this->statusOf($fileReply));
        self::assertSame('unconfirmed', $this->connection()->fetchOne('SELECT error FROM chat_outgoing WHERE id = :id', ['id' => $fileReply]));
    }

    public function testTheClaimsOwnAnswerReplacesUnconfirmed(): void
    {
        foreach ([[['sent' => false, 'error' => 'file_unavailable'], 'failed', 'file_unavailable'], [['sent' => true], 'sent', null]] as [$answer, $status, $error]) {
            $replyId = $this->queueFileReply('%PDF-1.4 late '.$status);
            $this->relay('outgoing/claim');
            $this->connection()->executeStatement("UPDATE chat_outgoing SET claimed_at = NOW() - INTERVAL '31 minutes' WHERE id = :id", ['id' => $replyId]);
            $this->sweep();
            self::assertSame('failed', $this->statusOf($replyId));

            $this->report($replyId, $answer);

            self::assertResponseIsSuccessful();
            self::assertSame([$status, $error], [$this->decodedResponse()['status'] ?? null, $this->decodedResponse()['error'] ?? null]);
        }

        $replyId = $this->queueFileReply('%PDF-1.4 unsure twice');
        $this->relay('outgoing/claim');
        $this->connection()->executeStatement("UPDATE chat_outgoing SET claimed_at = NOW() - INTERVAL '31 minutes' WHERE id = :id", ['id' => $replyId]);
        $this->sweep();
        $token = $this->tokenOf($replyId);
        $this->report($replyId, ['sent' => false, 'error' => 'unconfirmed']);
        self::assertResponseIsSuccessful();
        $this->report($replyId, ['sent' => false, 'error' => 'refused', 'claimToken' => 'another']);
        self::assertResponseStatusCodeSame(409, 'Only the claim\'s own answer.');
        self::assertSame($token, $this->tokenOf($replyId));
    }

    public function testTryAgainWaitsWhileAClaimThatMayStillRunLasts(): void
    {
        $replyId = $this->queueFileReply('%PDF-1.4 maybe');
        $this->relay('outgoing/claim');
        $this->report($replyId, ['sent' => false, 'error' => 'unconfirmed']);
        self::assertResponseIsSuccessful();

        $this->client->jsonRequest('POST', '/api/v1/chat-outgoing/'.$replyId.'/retry', [], $this->web);
        self::assertResponseStatusCodeSame(409);
        self::assertSame('still_sending', $this->decodedResponse()['code'] ?? null);
        $this->relay('outgoing/claim');
        self::assertResponseStatusCodeSame(204, 'Never handed out again meanwhile.');

        $this->connection()->executeStatement("UPDATE chat_outgoing SET claimed_at = NOW() - INTERVAL '31 minutes' WHERE id = :id", ['id' => $replyId]);
        $this->client->jsonRequest('POST', '/api/v1/chat-outgoing/'.$replyId.'/retry', [], $this->web);
        self::assertResponseIsSuccessful();
        self::assertSame('waiting', $this->decodedResponse()['status'] ?? null);
    }

    public function testAChatHoldsAtMostTwentyWaitingUploads(): void
    {
        for ($i = 0; $i < ChatUploads::MAX_UNQUEUED; ++$i) {
            $this->uploadForReply(Uuid::v7()->toRfc4122(), 'file '.$i);
            self::assertResponseStatusCodeSame(201);
        }

        $this->uploadForReply(Uuid::v7()->toRfc4122(), 'one more');

        self::assertResponseStatusCodeSame(429);
        self::assertSame(ChatUploads::MAX_UNQUEUED, $this->countRows('SELECT COUNT(*) FROM chat_upload'));
        self::assertCount(ChatUploads::MAX_UNQUEUED, $this->chatObjects(), 'Refused before it was stored.');
    }

    public function testAttachesCancelledBeforeTheirQueueingLeaveNoUploadBehind(): void
    {
        // Each of the three 4 KB uploads the 12 KB bound holds would stay without the release, and the fourth refused.
        for ($i = 0; $i < 10; ++$i) {
            $uploadId = Uuid::v7()->toRfc4122();
            $this->uploadForReply($uploadId, str_repeat((string) $i, 4000));
            self::assertResponseStatusCodeSame(201);
            $replyId = self::newReplyId();
            $this->client->request('DELETE', '/api/v1/chat-outgoing/'.$replyId, server: $this->web);
            self::assertResponseStatusCodeSame(204);
            $this->client->jsonRequest('POST', '/api/v1/chats/'.$this->chatId.'/outgoing', ['id' => $replyId, 'text' => '', 'file' => ['uploadId' => $uploadId, 'name' => 'a.txt']], $this->web);
            self::assertResponseStatusCodeSame(409);
            self::assertSame('cancelled', $this->decodedResponse()['code'] ?? null);
            $this->runCollections();
        }
        self::assertSame(0, $this->countRows('SELECT COUNT(*) FROM chat_upload'), 'Every refused queueing let its upload go.');
        self::assertSame([], $this->chatObjects(), 'And its file.');

        $this->queueFileReply(str_repeat('n', 4000));
    }

    public function testWaitingFilesAreBoundPerUser(): void
    {
        $ids = [];
        for ($i = 0; $i < 3; ++$i) {
            $ids[] = $id = Uuid::v7()->toRfc4122();
            $this->uploadForReply($id, str_repeat((string) $i, 4000));
            self::assertResponseStatusCodeSame(201);
        }

        $this->uploadForReply(Uuid::v7()->toRfc4122(), str_repeat('x', 4000));
        self::assertResponseStatusCodeSame(413);
        self::assertSame('too_much_waiting', $this->decodedResponse()['code'] ?? null);
        self::assertSame('Files waiting for your Mac take up more than 12 KB. Wait until they are sent, or cancel some, then attach this one again.', $this->decodedResponse()['detail'] ?? null);
        self::assertCount(3, $this->chatObjects(), 'Nothing more was stored.');

        // A reply that went out frees its share.
        $replyId = self::newReplyId();
        $this->client->jsonRequest('POST', '/api/v1/chats/'.$this->chatId.'/outgoing', ['id' => $replyId, 'text' => '', 'file' => ['uploadId' => $ids[0], 'name' => 'a.txt']], $this->web);
        $this->relay('outgoing/claim');
        $this->report($replyId, ['sent' => true]);
        $this->uploadForReply(Uuid::v7()->toRfc4122(), str_repeat('x', 4000));
        self::assertResponseStatusCodeSame(201);
    }

    public function testUploadsAreLimitedPerUser(): void
    {
        $id = Uuid::v7()->toRfc4122();
        for ($i = 0; $i < 25; ++$i) {
            $this->uploadForReply($id, 'the same file');
            self::assertResponseIsSuccessful();
        }

        $this->uploadForReply($id, 'the same file');

        self::assertResponseStatusCodeSame(429);
        self::assertNotNull($this->client->getResponse()->headers->get('Retry-After'));
    }

    public function testTheApiSweepsTemporaryFilesAKilledWorkerLeft(): void
    {
        $left = sys_get_temp_dir().'/'.ChatFileBody::TEMPORARY_PREFIX.'left-by-a-killed-worker';
        touch($left, time() - 7200);
        new \ReflectionProperty(ChatFileBody::class, 'sweptAt')->setValue(null, 0);

        $this->uploadForReply(Uuid::v7()->toRfc4122(), 'a file');

        self::assertResponseStatusCodeSame(201);
        self::assertFileDoesNotExist($left);
    }

    public function testAPersonalAccessTokenCannotUpload(): void
    {
        $this->uploadForReply(Uuid::v7()->toRfc4122(), 'from a script', $this->personalAccessTokenHeaders('kim@example.test', ['chat:read', 'chat:send']));

        self::assertResponseStatusCodeSame(403);
        self::assertSame(0, $this->countRows('SELECT COUNT(*) FROM chat_upload'));
    }

    public function testABodyWithoutALengthIsReadNoFurtherThanTheLimit(): void
    {
        $server = ['CONTENT_TYPE' => 'application/octet-stream', 'HTTP_TRANSFER_ENCODING' => 'chunked'] + $this->web;
        self::assertArrayNotHasKey('CONTENT_LENGTH', $server);

        $this->client->request('PUT', '/api/v1/chats/'.$this->chatId.'/uploads/'.Uuid::v7()->toRfc4122(), [], [], $server, str_repeat('x', 4097));
        self::assertResponseStatusCodeSame(413);
        $this->client->request('PUT', '/api/v1/chats/'.$this->chatId.'/uploads/'.Uuid::v7()->toRfc4122(), [], [], $server, str_repeat('x', 4096));
        self::assertResponseStatusCodeSame(201);
    }

    /**
     * @param array<string, string>|null $headers
     */
    private function requestMedia(string $messageId, ?array $headers = null): void
    {
        $this->client->jsonRequest('POST', '/api/v1/chat-messages/'.$messageId.'/media/request', [], $headers ?? $this->web);
    }

    /**
     * The relay's upload of a file, with the SHA-256 of $content unless given ('' leaves the header out).
     *
     * @param array<string, string>|null $headers
     */
    private function upload(string $messageId, string $content, ?string $sha256 = null, string $deviceId = self::MAC, ?array $headers = null): void
    {
        $sha256 ??= hash('sha256', $content);
        $server = ['CONTENT_TYPE' => 'application/octet-stream', 'HTTP_X_DEVICE_ID' => $deviceId] + ('' === $sha256 ? [] : ['HTTP_X_CONTENT_SHA256' => $sha256]) + ($headers ?? $this->desktop);
        $this->client->request('PUT', \sprintf('/api/v1/chat-accounts/%s/relay/media/%s', $this->accountId, $messageId), [], [], $server, $content);
    }

    /**
     * @param array<string, string>|null $headers
     */
    private function uploadForReply(string $uploadId, string $content, ?array $headers = null): void
    {
        $this->client->request('PUT', '/api/v1/chats/'.$this->chatId.'/uploads/'.$uploadId, [], [], ['CONTENT_TYPE' => 'application/octet-stream'] + ($headers ?? $this->web), $content);
    }

    /** Kim's photo, asked for, brought by the relay and scanned clean. */
    private function storePhoto(): void
    {
        $this->requestMedia($this->photoId);
        $this->relay('media/claim');
        $this->upload($this->photoId, self::PHOTO);
        $this->runQueuedScans();
    }

    /** A reply carrying a file with this content, queued from Kim's web app; returns its id. */
    private function queueFileReply(string $content): string
    {
        $uploadId = Uuid::v7()->toRfc4122();
        $this->uploadForReply($uploadId, $content);
        self::assertResponseStatusCodeSame(201);
        $replyId = self::newReplyId();
        $this->client->jsonRequest('POST', '/api/v1/chats/'.$this->chatId.'/outgoing', ['id' => $replyId, 'text' => '', 'file' => ['uploadId' => $uploadId, 'name' => 'file.pdf']], $this->web);
        self::assertResponseStatusCodeSame(201);

        return $replyId;
    }

    private function statusOf(string $replyId): mixed
    {
        return $this->connection()->fetchOne('SELECT status FROM chat_outgoing WHERE id = :id', ['id' => $replyId]);
    }

    /**
     * The scans queued on $transport since the last request, taken off it.
     *
     * @return list<Envelope>
     */
    private function takeScans(string $transport = 'scan'): array
    {
        $queue = static::getContainer()->get('messenger.transport.'.$transport);
        self::assertInstanceOf(InMemoryTransport::class, $queue);
        $envelopes = array_values([...$queue->getSent()]);
        $queue->reset();

        return $envelopes;
    }

    /**
     * Runs these scans and what they queue, as the scan worker would.
     *
     * @param list<Envelope> $envelopes
     */
    private function runScans(array $envelopes): void
    {
        $bus = static::getContainer()->get(MessageBusInterface::class);
        while ([] !== $envelopes) {
            foreach ($envelopes as $envelope) {
                $bus->dispatch($envelope->with(new ReceivedStamp('scan')));
            }
            $envelopes = $this->takeScans();
        }
        $this->chatEntityManager()->clear();
    }

    private function messageId(string $waId): string
    {
        $id = $this->deltaMessage($waId)['id'] ?? null;
        self::assertIsString($id);

        return $id;
    }

    /**
     * @return array<string, mixed>
     */
    private function deltaMessage(string $waId): array
    {
        foreach ($this->delta(0)['chatMessages'] as $message) {
            if ($waId === ($message['waId'] ?? null)) {
                return $message;
            }
        }
        self::fail('No message '.$waId.' in the delta.');
    }

    private function objectKey(string $messageId): string
    {
        $key = $this->connection()->fetchOne('SELECT media_object_key FROM chat_message WHERE id = :id', ['id' => $messageId]);
        self::assertIsString($key);

        return $key;
    }

    private function kimsId(): Uuid
    {
        $id = $this->connection()->fetchOne("SELECT id FROM app_user WHERE email = 'kim@example.test'");
        self::assertIsString($id);

        return Uuid::fromString($id);
    }

    /**
     * @return list<string> the WhatsApp objects in storage
     */
    private function chatObjects(): array
    {
        return array_values(array_filter($this->storage()->keys(), static fn (string $key): bool => str_starts_with($key, BlobKind::ChatMedia->value.'/')));
    }

    /**
     * Runs the removals of files the last request queued, as the worker would. Call it right after that request: the
     * test client empties the in-memory queues before the next.
     */
    private function runCollections(): void
    {
        $transport = static::getContainer()->get('messenger.transport.async');
        self::assertInstanceOf(InMemoryTransport::class, $transport);
        $bus = static::getContainer()->get(MessageBusInterface::class);
        $envelopes = array_values([...$transport->getSent()]);
        $transport->reset();
        foreach ($envelopes as $envelope) {
            if ($envelope->getMessage() instanceof CollectChatMedia) {
                $bus->dispatch($envelope->with(new ReceivedStamp('async')));
            }
        }
        static::getContainer()->get(EntityManagerInterface::class)->clear();
    }

    private function storage(): InMemoryObjectStorage
    {
        return static::getContainer()->get(InMemoryObjectStorage::class);
    }

    private function scanner(): FakeVirusScanner
    {
        return static::getContainer()->get(FakeVirusScanner::class);
    }
}
