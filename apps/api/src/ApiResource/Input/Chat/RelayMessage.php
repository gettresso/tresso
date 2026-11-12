<?php

declare(strict_types=1);

namespace App\ApiResource\Input\Chat;

use Symfony\Component\Validator\Constraints as Assert;

/**
 * One message of the bridge's store. The server knows it again by its chat and WhatsApp id, so sending it twice
 * stores it once.
 *
 * Only the shape is validated here (types, required fields, sizes): a request that breaks it is the relay's own bug
 * and refused whole (422). What the relay copies from the bridge's store and cannot repair (a JID that is not a chat
 * Tresso takes, a WhatsApp or sender id with other characters, a time before 2009 or more than a day ahead) refuses
 * that message alone ({@see \App\Chat\ChatIngestor}), so one bad row never holds the relay's cursor.
 */
final class RelayMessage
{
    /** Bytes a text or name may have: 65536 characters of up to four bytes each. */
    public const int MAX_FIELD_BYTES = 262_144;

    /** Bounds an id or JID in the request; what it may contain the ingestor checks per message. */
    public const int MAX_ID = 1024;

    #[Assert\Length(max: self::MAX_ID)]
    public string $chatJid = '';

    /** The bridge's message id. */
    #[Assert\Length(max: self::MAX_ID)]
    public string $waId = '';

    public bool $fromMe = false;

    /** Who wrote it in a group; null for the user's own messages and in a direct chat. */
    #[Assert\Valid]
    public ?RelaySender $sender = null;

    /** The text, or a file's caption; empty when there is none. */
    #[Assert\Length(max: RelayChat::MAX_FIELD)]
    #[Assert\Length(max: self::MAX_FIELD_BYTES, countUnit: Assert\Length::COUNT_BYTES)]
    public string $text = '';

    #[Assert\NotNull]
    public ?\DateTimeImmutable $sentAt = null;

    #[Assert\Valid]
    public ?RelayMedia $media = null;
}
