<?php

declare(strict_types=1);

namespace App\ApiResource\Input\Chat;

use Symfony\Component\Validator\Constraints as Assert;

/**
 * Who wrote a message in a group: the number or JID the bridge stores, and the name the desktop found for it. An id
 * with other characters than visible ASCII refuses its message alone ({@see \App\Chat\ChatIngestor}).
 */
final class RelaySender
{
    #[Assert\Length(max: RelayMessage::MAX_ID)]
    public string $id = '';

    /** Stored cut to 255 characters, without control characters. */
    #[Assert\Length(max: RelayChat::MAX_FIELD)]
    #[Assert\Length(max: RelayMessage::MAX_FIELD_BYTES, countUnit: Assert\Length::COUNT_BYTES)]
    public ?string $name = null;
}
