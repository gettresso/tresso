<?php

declare(strict_types=1);

namespace App\Chat;

use Symfony\Component\Uid\Uuid;

/**
 * Every sealed chat column: where it is stored and the context it is sealed for. A value sealed for one field or row
 * does not open as another. Re-encryption walks this list, so a column added here is resealed after a key rotation.
 */
enum ChatField: string
{
    case AccountAddress = 'chat-account-address';
    case AccountName = 'chat-account-name';
    case Jid = 'chat-jid';
    case Name = 'chat-name';
    case MessageWaId = 'chat-message-wa-id';
    case MessageSender = 'chat-message-sender';
    case MessageText = 'chat-message-text';
    case MessageMedia = 'chat-message-media';
    case OutgoingText = 'chat-outgoing-text';

    /** The context a value of this field in row $id is sealed for. */
    public function context(Uuid $id): string
    {
        return 'tresso:'.$this->value.':'.$id->toRfc4122();
    }

    public function table(): string
    {
        return match ($this) {
            self::AccountAddress, self::AccountName => 'chat_account',
            self::Jid, self::Name => 'chat',
            self::MessageWaId, self::MessageSender, self::MessageText, self::MessageMedia => 'chat_message',
            self::OutgoingText => 'chat_outgoing',
        };
    }

    public function column(): string
    {
        return match ($this) {
            self::AccountAddress => 'sealed_address',
            self::AccountName => 'sealed_display_name',
            self::Jid => 'sealed_jid',
            self::Name => 'sealed_name',
            self::MessageWaId => 'sealed_wa_id',
            self::MessageSender => 'sealed_sender',
            self::MessageText, self::OutgoingText => 'sealed_text',
            self::MessageMedia => 'sealed_media_name',
        };
    }

    /**
     * SQL that selects the rows of the owner (:owner) in this field's table, as `x`: the account by its owner, the rest
     * through their account.
     */
    public function ownedRows(): string
    {
        return 'chat_account' === $this->table()
            ? 'chat_account x WHERE x.owner_id = :owner'
            : \sprintf('%s x JOIN chat_account a ON a.id = x.chat_account_id WHERE a.owner_id = :owner', $this->table());
    }
}
