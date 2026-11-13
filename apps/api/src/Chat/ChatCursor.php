<?php

declare(strict_types=1);

namespace App\Chat;

use Symfony\Component\HttpKernel\Exception\BadRequestHttpException;
use Symfony\Component\Uid\Uuid;

/**
 * Where a page of chats, of a chat's messages or of a search ended: the time, kind and id of its last row, in the order
 * the pages are read (newest first). The next page starts after it. To the client it is an opaque string; it says
 * nothing about the chat beyond a time and a row id the client was already given.
 *
 * Times are the database's own text of a `TIMESTAMP(0)` column (`2026-11-12 09:30:00`), so comparing them as text
 * compares them as times. The rank orders rows of one time: in a chat, a reply (1) before a message (0), newest first.
 * Ids compare as Postgres compares UUIDs, byte by byte, which is the order of their lower-case text.
 */
final readonly class ChatCursor
{
    public const int MESSAGE = 0;
    public const int REPLY = 1;

    private const string TIME = '/^\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}$/';

    private function __construct(
        public string $at,
        public int $rank,
        public string $id,
    ) {
    }

    public static function of(string $at, int $rank, string $id): self
    {
        if (1 !== preg_match(self::TIME, $at) || !\in_array($rank, [self::MESSAGE, self::REPLY], true) || !Uuid::isValid($id)) {
            throw new \LogicException('A cursor is made from a stored time, a rank and a row id.');
        }

        return new self($at, $rank, strtolower(Uuid::fromString($id)->toRfc4122()));
    }

    /**
     * The cursor a client sent back, or null for none.
     *
     * @throws BadRequestHttpException when it is not one this API handed out
     */
    public static function fromQuery(mixed $value): ?self
    {
        if (null === $value || '' === $value) {
            return null;
        }
        $raw = \is_string($value) && \strlen($value) <= 200 ? base64_decode(strtr($value, '-_', '+/'), true) : false;
        $parts = false === $raw ? null : json_decode($raw, true);
        if (!\is_array($parts) || !array_is_list($parts) || 3 !== \count($parts)
            || !\is_string($parts[0]) || 1 !== preg_match(self::TIME, $parts[0])
            || !\is_int($parts[1]) || !\in_array($parts[1], [self::MESSAGE, self::REPLY], true)
            || !\is_string($parts[2]) || !Uuid::isValid($parts[2])) {
            throw new BadRequestHttpException('cursor is not one this API gave; leave it out to start from the newest.');
        }

        return self::of($parts[0], $parts[1], $parts[2]);
    }

    public function encode(): string
    {
        return rtrim(strtr(base64_encode(json_encode([$this->at, $this->rank, $this->id], \JSON_THROW_ON_ERROR)), '+/', '-_'), '=');
    }

    /** Whether a row with this key comes before $other in a newest-first read: a greater time, rank or id. */
    public function after(self $other): bool
    {
        $at = strcmp($this->at, $other->at);
        if (0 !== $at) {
            return $at > 0;
        }
        if ($this->rank !== $other->rank) {
            return $this->rank > $other->rank;
        }

        return strcmp($this->id, $other->id) > 0;
    }
}
