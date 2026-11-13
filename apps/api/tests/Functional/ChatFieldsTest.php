<?php

declare(strict_types=1);

namespace App\Tests\Functional;

use App\Chat\ChatField;
use App\Entity\Chat;
use App\Entity\ChatAccount;
use App\Entity\ChatMessage;
use App\Entity\ChatOutgoing;
use App\Entity\User;
use App\Enum\ChatKind;
use App\Enum\ChatMediaKind;
use App\Repository\ChatMessageRepository;
use App\Repository\ChatOutgoingRepository;
use App\Repository\ChatRepository;
use App\Security\Crypto\CryptoException;
use App\Security\Crypto\UserKeys;
use App\Storage\BlobVault;
use App\Storage\Reencryption;
use Doctrine\DBAL\Exception\UniqueConstraintViolationException;
use Symfony\Bundle\FrameworkBundle\Console\Application;
use Symfony\Component\Console\Tester\CommandTester;
use Symfony\Component\Uid\Uuid;

/**
 * What a chat says and who it is with is sealed with the owner's field key, bound to its field and row; the server
 * finds chats and messages by fingerprints only, and a key rotation reseals every chat column.
 */
final class ChatFieldsTest extends DatabaseTestCase
{
    use AuthenticatesUsers;
    use StoresChats;

    private const string JID = '31612345678@s.whatsapp.net';
    private const string GROUP_JID = '120363025246125486@g.us';
    private const string WA_ID = '3EB0C431C26A1916F5B9';

    private User $kim;
    private ChatAccount $account;
    private Chat $chat;
    private ChatMessage $message;
    private ChatOutgoing $outgoing;

    protected function setUp(): void
    {
        parent::setUp();
        $this->kim = $this->createUser('kim@example.test', 'Kim');
        $this->account = $this->storeChatAccount($this->kim, '31698765432', 'Kim Visser');
        $this->chat = $this->storeChat($this->account, self::JID, 'Anna de Vries');
        [$this->message] = $this->storeChatMessages($this->chat, [[
            'waId' => self::WA_ID,
            'text' => 'See you at the station at nine',
            'sender' => ['id' => '31612345678', 'name' => 'Anna'],
            'media' => [ChatMediaKind::Document, 'tickets-amsterdam.pdf', 48_213],
        ]]);
        $this->outgoing = $this->storeChatOutgoing($this->chat, 'On my way', ['menu-for-saturday.pdf', '%PDF-1.4 menu']);
        $this->chatEntityManager()->clear();
    }

    public function testSealsAndOpensEveryField(): void
    {
        $fields = $this->chatFields();
        $account = $this->findChatAccount($this->account->getId()->toRfc4122());
        $chat = $this->chatEntityManager()->find(Chat::class, $this->chat->getId());
        $message = $this->chatEntityManager()->find(ChatMessage::class, $this->message->getId());
        $outgoing = $this->chatEntityManager()->find(ChatOutgoing::class, $this->outgoing->getId());
        self::assertInstanceOf(Chat::class, $chat);
        self::assertInstanceOf(ChatMessage::class, $message);
        self::assertInstanceOf(ChatOutgoing::class, $outgoing);

        self::assertSame('31698765432', $fields->accountAddress($account));
        self::assertSame('Kim Visser', $fields->accountDisplayName($account));
        self::assertSame(self::JID, $fields->jid($chat));
        self::assertSame('Anna de Vries', $fields->name($chat));
        self::assertSame(self::WA_ID, $fields->waId($message));
        self::assertSame(['id' => '31612345678', 'name' => 'Anna'], $fields->sender($message));
        self::assertSame('See you at the station at nine', $fields->text($message));
        self::assertSame('tickets-amsterdam.pdf', $fields->mediaName($message));
        self::assertSame(ChatMediaKind::Document, $message->getMediaKind());
        self::assertSame(48_213, $message->getMediaSize());
        self::assertSame('On my way', $fields->outgoingText($outgoing));
        self::assertSame('menu-for-saturday.pdf', $fields->outgoingFileName($outgoing));
    }

    public function testEmptyAndMissingValuesStaySo(): void
    {
        $account = $this->storeChatAccount($this->createUser('lisa@example.test', 'Lisa'), null, null);
        $chat = $this->storeChat($account, self::GROUP_JID, null, ChatKind::Group);
        [$message] = $this->storeChatMessages($chat, [['waId' => 'A1', 'text' => '', 'fromMe' => true]]);

        self::assertNull($account->getSealedAddress());
        self::assertNull($this->chatFields()->accountAddress($account));
        self::assertNull($this->chatFields()->name($chat));
        self::assertNull($this->chatFields()->sender($message));
        self::assertNull($this->chatFields()->mediaName($message));
        self::assertSame('', $this->chatFields()->text($message));
        self::assertTrue(str_starts_with($message->getSealedText(), 'f1.'), 'Even an empty text is sealed: its row says nothing.');
    }

    public function testAnUnchangedIdentityIsNotSealedAgain(): void
    {
        $account = $this->findChatAccount($this->account->getId()->toRfc4122());
        $sealed = [$account->getSealedAddress(), $account->getSealedDisplayName()];

        $this->chatFields()->setAccountIdentity($account, '31698765432', 'Kim Visser');
        self::assertSame($sealed, [$account->getSealedAddress(), $account->getSealedDisplayName()]);

        $this->chatFields()->setAccountIdentity($account, '31698765432', 'Kim');
        self::assertSame($sealed[0], $account->getSealedAddress());
        self::assertNotSame($sealed[1], $account->getSealedDisplayName());
        self::assertSame('Kim', $this->chatFields()->accountDisplayName($account));
    }

    /**
     * @return iterable<string, array{ChatField, string}>
     */
    private static function sealedColumns(): iterable
    {
        foreach (ChatField::cases() as $field) {
            yield $field->name => [$field, $field->table()];
        }
    }

    public function testAValueSealedForOneRowDoesNotOpenForAnother(): void
    {
        $other = $this->storeChat($this->findChatAccount($this->account->getId()->toRfc4122()), self::GROUP_JID, 'Family', ChatKind::Group);
        $sealedJid = $this->connection()->fetchOne('SELECT sealed_jid FROM chat WHERE id = :id', ['id' => $this->chat->getId()->toRfc4122()]);
        self::assertIsString($sealedJid);
        $owner = $this->kim->getId();

        self::assertSame(self::JID, $this->chatFields()->open($owner, ChatField::Jid, $this->chat->getId(), $sealedJid));
        foreach ([[ChatField::Jid, $other->getId()], [ChatField::Name, $this->chat->getId()], [ChatField::MessageText, $this->chat->getId()]] as [$field, $row]) {
            try {
                $this->chatFields()->open($owner, $field, $row, $sealedJid);
                self::fail(\sprintf('A JID sealed for chat %s opened as %s of %s.', $this->chat->getId()->toRfc4122(), $field->name, $row->toRfc4122()));
            } catch (CryptoException) {
                // Bound to its field and row.
            }
        }

        // Copied over in the database, it does not open either.
        $this->connection()->executeStatement('UPDATE chat SET sealed_jid = :sealed WHERE id = :id', ['sealed' => $sealedJid, 'id' => $other->getId()->toRfc4122()]);
        $this->chatEntityManager()->clear();
        $copied = $this->chatEntityManager()->find(Chat::class, $other->getId());
        self::assertInstanceOf(Chat::class, $copied);
        $this->expectException(CryptoException::class);
        $this->chatFields()->jid($copied);
    }

    public function testAValueSealedForOneOwnerDoesNotOpenForAnother(): void
    {
        $lisa = $this->createUser('lisa@example.test', 'Lisa');
        $sealedText = $this->connection()->fetchOne('SELECT sealed_text FROM chat_message WHERE id = :id', ['id' => $this->message->getId()->toRfc4122()]);
        self::assertIsString($sealedText);

        $this->expectException(CryptoException::class);
        $this->chatFields()->open($lisa->getId(), ChatField::MessageText, $this->message->getId(), $sealedText);
    }

    public function testTheDatabaseHoldsNoPlaintextOfWhoOrWhat(): void
    {
        $rows = json_encode([
            $this->connection()->fetchAllAssociative('SELECT * FROM chat_account'),
            $this->connection()->fetchAllAssociative('SELECT * FROM chat'),
            $this->connection()->fetchAllAssociative('SELECT * FROM chat_message'),
            $this->connection()->fetchAllAssociative('SELECT * FROM chat_outgoing'),
        ], \JSON_THROW_ON_ERROR);

        foreach (['31698765432', 'Kim Visser', '31612345678', 'whatsapp.net', 'Anna', self::WA_ID, 'station', 'tickets-amsterdam', 'On my way', 'menu-for-saturday'] as $plaintext) {
            self::assertStringNotContainsString($plaintext, $rows);
        }
        self::assertStringNotContainsString(hash('sha256', self::JID), $rows, 'The fingerprint is keyed, not a plain hash anyone can recompute from a number.');
        foreach (self::sealedColumns() as [$field, $table]) {
            $values = $this->connection()->fetchFirstColumn(\sprintf('SELECT %s FROM %s WHERE %1$s IS NOT NULL', $field->column(), $table));
            self::assertNotSame([], $values, $field->name);
            foreach ($values as $value) {
                self::assertIsString($value);
                self::assertStringStartsWith('f1.1.', $value, $field->name.' is sealed with the current key.');
            }
        }
    }

    public function testChatsAndMessagesAreFoundByFingerprint(): void
    {
        $fields = $this->chatFields();
        $owner = $this->kim->getId();
        $account = $this->findChatAccount($this->account->getId()->toRfc4122());

        $fingerprint = $fields->jidFingerprint($owner, self::JID);
        self::assertMatchesRegularExpression('/^[0-9a-f]{64}$/', $fingerprint);
        self::assertSame($fingerprint, $fields->jidFingerprint($owner, self::JID), 'The same JID always gives the same fingerprint.');
        $chat = static::getContainer()->get(ChatRepository::class)->findOneByJidFingerprint($account, $fingerprint);
        self::assertInstanceOf(Chat::class, $chat);
        self::assertSame($this->chat->getId()->toRfc4122(), $chat->getId()->toRfc4122());
        self::assertNull(static::getContainer()->get(ChatRepository::class)->findOneByJidFingerprint($account, $fields->jidFingerprint($owner, self::GROUP_JID)));

        $message = static::getContainer()->get(ChatMessageRepository::class)->findOneByWaFingerprint($chat, $fields->messageFingerprint($owner, self::JID, self::WA_ID));
        self::assertInstanceOf(ChatMessage::class, $message);
        self::assertSame($this->message->getId()->toRfc4122(), $message->getId()->toRfc4122());
        self::assertNotSame(
            $fields->messageFingerprint($owner, self::JID, self::WA_ID),
            $fields->messageFingerprint($owner, self::GROUP_JID, self::WA_ID),
            'A WhatsApp id is named within its chat.',
        );

        $lisa = $this->createUser('lisa@example.test', 'Lisa');
        self::assertNotSame($fingerprint, $fields->jidFingerprint($lisa->getId(), self::JID), 'Fingerprints are per owner: two users with one contact share nothing.');
    }

    public function testAChatIsStoredOncePerAccount(): void
    {
        $this->expectException(UniqueConstraintViolationException::class);
        $this->storeChat($this->findChatAccount($this->account->getId()->toRfc4122()), self::JID, 'Anna again');
    }

    public function testChatsAndRepliesAreFoundOnlyThroughTheirOwner(): void
    {
        $lisa = $this->createUser('lisa@example.test', 'Lisa');
        $chats = static::getContainer()->get(ChatRepository::class);
        $outgoing = static::getContainer()->get(ChatOutgoingRepository::class);
        $kim = $this->chatEntityManager()->find(User::class, $this->kim->getId());
        self::assertInstanceOf(User::class, $kim);

        self::assertNotNull($chats->findOneOwnedBy($kim, $this->chat->getId()->toRfc4122()));
        self::assertNotNull($outgoing->findOneOwnedBy($kim, $this->outgoing->getId()->toRfc4122()));
        self::assertNull($chats->findOneOwnedBy($lisa, $this->chat->getId()->toRfc4122()));
        self::assertNull($outgoing->findOneOwnedBy($lisa, $this->outgoing->getId()->toRfc4122()));
        self::assertNull($chats->findOneOwnedBy($kim, 'not-a-uuid'));
    }

    public function testRotationResealsEveryChatColumnAndTheChatStillReads(): void
    {
        $before = $this->connection()->fetchAllKeyValue('SELECT id, change_seq FROM chat_message');
        $tester = new CommandTester(new Application($this->client->getKernel())->find('app:crypto:rotate-user-keys'));
        $tester->execute(['--user' => ['kim@example.test']]);
        $tester->assertCommandIsSuccessful();
        static::getContainer()->get(UserKeys::class)->reset();
        $reencryption = static::getContainer()->get(Reencryption::class);

        // Account: number and name; chat: JID and name; message: id, sender, text, file name; reply: text, file name.
        self::assertSame(10, $reencryption->remaining($this->kim->getId())['chatFields']);
        self::assertSame(1, $reencryption->remaining($this->kim->getId())['chatMedia'], 'The file the reply carries.');

        $result = $reencryption->run($this->kim->getId(), 2, static function (): void {});

        self::assertSame(0, $result->failed);
        self::assertSame(0, array_sum($reencryption->remaining($this->kim->getId())), 'Nothing is left on the old key.');
        foreach (self::sealedColumns() as [$field, $table]) {
            foreach ($this->connection()->fetchFirstColumn(\sprintf('SELECT %s FROM %s WHERE %1$s IS NOT NULL', $field->column(), $table)) as $value) {
                self::assertIsString($value);
                self::assertStringStartsWith('f1.2.', $value, $field->name.' is resealed with the new key.');
            }
        }
        self::assertSame($before, $this->connection()->fetchAllKeyValue('SELECT id, change_seq FROM chat_message'), 'Resealing is no change for clients.');

        $this->chatEntityManager()->clear();
        $chat = $this->chatEntityManager()->find(Chat::class, $this->chat->getId());
        $message = $this->chatEntityManager()->find(ChatMessage::class, $this->message->getId());
        self::assertInstanceOf(Chat::class, $chat);
        self::assertInstanceOf(ChatMessage::class, $message);
        self::assertSame(self::JID, $this->chatFields()->jid($chat));
        self::assertSame('See you at the station at nine', $this->chatFields()->text($message));
        self::assertSame(['id' => '31612345678', 'name' => 'Anna'], $this->chatFields()->sender($message));
        self::assertSame('Kim Visser', $this->chatFields()->accountDisplayName($chat->getChatAccount()));
        $outgoing = $this->chatEntityManager()->find(ChatOutgoing::class, $this->outgoing->getId());
        self::assertInstanceOf(ChatOutgoing::class, $outgoing);
        self::assertSame(2, $outgoing->getFileKeyVersion(), 'The file is written again with the new key.');
        $key = $outgoing->getFileObjectKey();
        self::assertIsString($key);
        self::assertSame('%PDF-1.4 menu', static::getContainer()->get(BlobVault::class)->read($this->kim->getId(), $key));
        self::assertSame($this->chat->getJidFingerprint(), $this->chatFields()->jidFingerprint($this->kim->getId(), self::JID), 'Fingerprints do not depend on the key version.');
    }
}
