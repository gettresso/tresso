<?php

declare(strict_types=1);

namespace App\Activity;

use App\Entity\AppActivity;
use Symfony\Component\Uid\Uuid;

/**
 * Where a page of the activity log ends: the time and id of its last entry, as one opaque string for "Show older
 * entries".
 */
final readonly class ActivityCursor
{
    private function __construct(
        public \DateTimeImmutable $at,
        public Uuid $id,
    ) {
    }

    public static function after(AppActivity $entry): self
    {
        return new self($entry->getOccurredAt(), $entry->getId());
    }

    /** Null for a value that is no cursor of ours. */
    public static function fromString(string $value): ?self
    {
        $decoded = base64_decode(strtr($value, '-_', '+/'), true);
        if (false === $decoded || 1 !== preg_match('/^(\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2})\|([0-9a-f-]{36})$/', $decoded, $parts) || !Uuid::isValid($parts[2])) {
            return null;
        }
        $at = \DateTimeImmutable::createFromFormat('!Y-m-d H:i:s', $parts[1]);

        return false === $at ? null : new self($at, Uuid::fromString($parts[2]));
    }

    public function toString(): string
    {
        return rtrim(strtr(base64_encode($this->at->format('Y-m-d H:i:s').'|'.$this->id->toRfc4122()), '+/', '-_'), '=');
    }
}
