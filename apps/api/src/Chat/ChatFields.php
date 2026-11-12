<?php

declare(strict_types=1);

namespace App\Chat;

use App\Entity\Chat;
use App\Entity\ChatAccount;
use App\Entity\ChatMessage;
use App\Entity\ChatOutgoing;
use App\Enum\ChatKind;
use App\Enum\ChatMediaKind;
use App\Security\Crypto\FieldVault;
use App\Security\Crypto\UserKeys;
use Symfony\Component\Uid\Uuid;

/**
 * Seals and opens what a chat says and who it is with, with the owner's field key, each value bound to its field and
 * row ({@see ChatField}). Mail keeps addresses and names readable because the server queries them; for chats the
 * server only asks "do I have this one", which a fingerprint under the owner's index key answers. So the own number and
 * name, every JID, chat name, WhatsApp id, sender, text and file name is sealed, and what stays readable is kinds,
 * times, counts, sizes and states.
 */
final readonly class ChatFields
{
    public function __construct(
        private FieldVault $vault,
        private UserKeys $keys,
    ) {
    }

    /** Names a chat within its owner without its JID: what the server looks a chat up by. */
    public function jidFingerprint(Uuid $owner, #[\SensitiveParameter] string $jid): string
    {
        return $this->keys->fingerprint($owner, hash('sha256', $jid, true));
    }

    /** Names a message within its owner without its JID or WhatsApp id: what the server looks a message up by. */
    public function messageFingerprint(Uuid $owner, #[\SensitiveParameter] string $jid, #[\SensitiveParameter] string $waId): string
    {
        return $this->keys->fingerprint($owner, hash('sha256', $jid."\n".$waId, true));
    }

    /**
     * Sets the own number and name. An unchanged value is kept as sealed, so it is no change for clients.
     */
    public function setAccountIdentity(ChatAccount $account, #[\SensitiveParameter] ?string $address, #[\SensitiveParameter] ?string $displayName): void
    {
        $owner = self::ownerOf($account);
        $sealedAddress = $address === $this->accountAddress($account)
            ? $account->getSealedAddress()
            : $this->sealNullable($owner, ChatField::AccountAddress, $account->getId(), $address);
        $sealedName = $displayName === $this->accountDisplayName($account)
            ? $account->getSealedDisplayName()
            : $this->sealNullable($owner, ChatField::AccountName, $account->getId(), $displayName);
        $account->sealIdentity($sealedAddress, $sealedName);
    }

    public function accountAddress(ChatAccount $account): ?string
    {
        return $this->open(self::ownerOf($account), ChatField::AccountAddress, $account->getId(), $account->getSealedAddress());
    }

    public function accountDisplayName(ChatAccount $account): ?string
    {
        return $this->open(self::ownerOf($account), ChatField::AccountName, $account->getId(), $account->getSealedDisplayName());
    }

    public function newChat(ChatAccount $account, #[\SensitiveParameter] string $jid, #[\SensitiveParameter] ?string $name, ChatKind $kind, \DateTimeImmutable $lastMessageAt): Chat
    {
        $owner = self::ownerOf($account);
        $id = Uuid::v7();

        return new Chat(
            $id,
            $account,
            $this->jidFingerprint($owner, $jid),
            $this->seal($owner, ChatField::Jid, $id, $jid),
            $this->sealNullable($owner, ChatField::Name, $id, $name),
            $kind,
            $lastMessageAt,
        );
    }

    public function jid(Chat $chat): string
    {
        return $this->vault->open(self::ownerOf($chat->getChatAccount()), ChatField::Jid->context($chat->getId()), $chat->getSealedJid());
    }

    public function name(Chat $chat): ?string
    {
        return $this->open(self::ownerOf($chat->getChatAccount()), ChatField::Name, $chat->getId(), $chat->getSealedName());
    }

    /** Sets the chat's name. An unchanged name is kept as sealed, so it is no change for clients. */
    public function rename(Chat $chat, #[\SensitiveParameter] ?string $name): void
    {
        if ($name === $this->name($chat)) {
            return;
        }
        $chat->sealName($this->sealNullable(self::ownerOf($chat->getChatAccount()), ChatField::Name, $chat->getId(), $name));
    }

    /**
     * @param array{id: string, name: ?string}|null $sender who wrote it in a group, or the person of a direct chat
     */
    public function newMessage(
        Chat $chat,
        #[\SensitiveParameter] string $waId,
        bool $fromMe,
        \DateTimeImmutable $sentAt,
        #[\SensitiveParameter] ?array $sender,
        #[\SensitiveParameter] string $text,
        ?ChatMediaKind $mediaKind,
        #[\SensitiveParameter] ?string $mediaName,
        ?int $mediaSize,
    ): ChatMessage {
        $owner = self::ownerOf($chat->getChatAccount());
        $id = Uuid::v7();

        return new ChatMessage(
            $id,
            $chat,
            $this->messageFingerprint($owner, $this->jid($chat), $waId),
            $fromMe,
            $sentAt,
            $this->seal($owner, ChatField::MessageWaId, $id, $waId),
            null === $sender ? null : $this->seal($owner, ChatField::MessageSender, $id, json_encode(['id' => $sender['id'], 'name' => $sender['name']], \JSON_THROW_ON_ERROR | \JSON_UNESCAPED_UNICODE)),
            $this->seal($owner, ChatField::MessageText, $id, $text),
            $mediaKind,
            $this->sealNullable($owner, ChatField::MessageMedia, $id, $mediaName),
            $mediaSize,
        );
    }

    public function waId(ChatMessage $message): string
    {
        return $this->vault->open(self::ownerOf($message->getChatAccount()), ChatField::MessageWaId->context($message->getId()), $message->getSealedWaId());
    }

    /**
     * @return array{id: string, name: ?string}|null
     */
    public function sender(ChatMessage $message): ?array
    {
        return self::decodeSender($this->open(self::ownerOf($message->getChatAccount()), ChatField::MessageSender, $message->getId(), $message->getSealedSender()));
    }

    public function text(ChatMessage $message): string
    {
        return $this->vault->open(self::ownerOf($message->getChatAccount()), ChatField::MessageText->context($message->getId()), $message->getSealedText());
    }

    public function mediaName(ChatMessage $message): ?string
    {
        return $this->open(self::ownerOf($message->getChatAccount()), ChatField::MessageMedia, $message->getId(), $message->getSealedMediaName());
    }

    /** $id comes from the client, so a repeated request names the same reply. */
    public function newOutgoing(Uuid $id, Chat $chat, #[\SensitiveParameter] string $text, \DateTimeImmutable $now): ChatOutgoing
    {
        return new ChatOutgoing($id, $chat, $this->seal(self::ownerOf($chat->getChatAccount()), ChatField::OutgoingText, $id, $text), $now);
    }

    public function outgoingText(ChatOutgoing $outgoing): string
    {
        return $this->vault->open(self::ownerOf($outgoing->getChatAccount()), ChatField::OutgoingText->context($outgoing->getId()), $outgoing->getSealedText());
    }

    /** A sealed value of a row read in SQL, opened; null stays null. */
    public function open(Uuid $owner, ChatField $field, Uuid $rowId, ?string $sealed): ?string
    {
        return $this->vault->openNullable($owner, $field->context($rowId), $sealed);
    }

    /** A sealed value of a row read in SQL (sealed with any key version the owner has), sealed with the current one. */
    public function reseal(Uuid $owner, ChatField $field, Uuid $rowId, string $sealed): string
    {
        return $this->seal($owner, $field, $rowId, $this->vault->open($owner, $field->context($rowId), $sealed));
    }

    /**
     * The sender as stored (JSON), decoded.
     *
     * @return array{id: string, name: ?string}|null
     */
    public static function decodeSender(#[\SensitiveParameter] ?string $json): ?array
    {
        if (null === $json) {
            return null;
        }
        $sender = json_decode($json, true, flags: \JSON_THROW_ON_ERROR);
        $id = \is_array($sender) ? ($sender['id'] ?? null) : null;
        $name = \is_array($sender) ? ($sender['name'] ?? null) : null;
        if (!\is_string($id) || (null !== $name && !\is_string($name))) {
            throw new \UnexpectedValueException('A stored chat sender is not {id, name}.');
        }

        return ['id' => $id, 'name' => $name];
    }

    private function seal(Uuid $owner, ChatField $field, Uuid $rowId, #[\SensitiveParameter] string $plaintext): string
    {
        return $this->vault->seal($owner, $field->context($rowId), $plaintext);
    }

    private function sealNullable(Uuid $owner, ChatField $field, Uuid $rowId, #[\SensitiveParameter] ?string $plaintext): ?string
    {
        return null === $plaintext ? null : $this->seal($owner, $field, $rowId, $plaintext);
    }

    private static function ownerOf(ChatAccount $account): Uuid
    {
        return $account->getOwner()->getId();
    }
}
