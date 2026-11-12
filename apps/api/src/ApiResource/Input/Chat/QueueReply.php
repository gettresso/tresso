<?php

declare(strict_types=1);

namespace App\ApiResource\Input\Chat;

use Symfony\Component\Uid\Uuid;
use Symfony\Component\Uid\UuidV7;
use Symfony\Component\Validator\Constraints as Assert;
use Symfony\Component\Validator\ConstraintViolation;
use Symfony\Component\Validator\ConstraintViolationList;

/**
 * A reply the user wrote in a chat, queued for the relaying desktop. The id comes from the client, so a request sent
 * again (its answer got lost) returns the reply queued the first time instead of a second one.
 */
final class QueueReply
{
    public const int MAX_TEXT = 4096;

    /** How far ahead of the server an id may be made: a little clock skew, as for mail ({@see \App\ApiResource\Input\Outbox\SendMessageInput}). */
    private const string ID_AHEAD = '+5 minutes';

    /**
     * How old an id may be when its reply is queued for the first time. A request sent again much later (a device that
     * was offline, or a reply cancelled meanwhile) must not queue a reply the user no longer expects to go out.
     */
    private const string ID_BEHIND = '-10 minutes';

    /** A UUIDv7 the client made when the user pressed Send. */
    #[Assert\NotBlank]
    #[Assert\Uuid(versions: [Assert\Uuid::V7_MONOTONIC])]
    public string $id = '';

    /** Trimmed before it is stored. Line breaks and tabs are fine; other control characters are not. */
    #[Assert\NotBlank(normalizer: 'trim', message: 'Write a reply.')]
    #[Assert\Length(max: self::MAX_TEXT, normalizer: 'trim')]
    #[Assert\Regex('/[\x00-\x08\x0B\x0C\x0E-\x1F\x7F]/', message: 'The reply cannot contain control characters.', match: false)]
    public string $text = '';

    /**
     * The id was made within the last 10 minutes (5 minutes of clock skew ahead are fine). Checked only for a reply that
     * is not queued yet, so a late repeat of a request still gets its reply back.
     */
    public function idViolations(\DateTimeImmutable $now): ConstraintViolationList
    {
        $violations = new ConstraintViolationList();
        $id = Uuid::fromString($this->id);
        if ($id instanceof UuidV7 && $id->getDateTime() > $now->modify(self::ID_AHEAD)) {
            $violations->add(new ConstraintViolation('The id lies in the future; check the clock of this device.', null, [], $this, 'id', null));
        }
        if ($id instanceof UuidV7 && $id->getDateTime() < $now->modify(self::ID_BEHIND)) {
            $violations->add(new ConstraintViolation('The id was made more than 10 minutes ago; make a new one.', null, [], $this, 'id', null));
        }

        return $violations;
    }
}
