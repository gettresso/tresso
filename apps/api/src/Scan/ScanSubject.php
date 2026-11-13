<?php

declare(strict_types=1);

namespace App\Scan;

use App\Entity\Attachment;
use App\Entity\ChatMessage;
use App\Entity\DraftAttachment;
use App\Enum\ScanStatus;
use Symfony\Component\Uid\Uuid;

/**
 * What a scan job needs of the attachment it names: its content (by fingerprint, or the SHA-256 of content stored
 * before encryption), whose it is, how large it is, its current status, and where the content may be stored (its own
 * key, then quarantine).
 */
final readonly class ScanSubject
{
    /**
     * @param list<string> $keys
     */
    private function __construct(
        public string $sha256,
        public Uuid $owner,
        public bool $encrypted,
        public int $size,
        public ScanStatus $status,
        public array $keys,
    ) {
    }

    public static function ofAttachment(Attachment $attachment): self
    {
        return new self($attachment->getSha256(), $attachment->getMailAccount()->getOwner()->getId(), null !== $attachment->getKeyVersion(), $attachment->getSize(), $attachment->getScanStatus(), [$attachment->getObjectKey(), $attachment->getQuarantineKey()]);
    }

    /** Null while the message's file is not stored. */
    public static function ofChatMessage(ChatMessage $message): ?self
    {
        $fingerprint = $message->getMediaSha256();
        $key = $message->getMediaObjectKey();
        $status = $message->getMediaScanStatus();
        if (null === $fingerprint || null === $key || null === $status) {
            return null;
        }
        $owner = $message->getChatAccount()->getOwner()->getId();

        return new self($fingerprint, $owner, true, $message->getMediaStoredSize() ?? 0, $status, [$key, Attachment::quarantineKey($fingerprint, $owner)]);
    }

    public static function ofDraftAttachment(DraftAttachment $attachment): self
    {
        return new self($attachment->getSha256(), $attachment->getDraft()->getOwner()->getId(), null !== $attachment->getKeyVersion(), $attachment->getSize(), $attachment->getScanStatus(), [$attachment->getObjectKey(), $attachment->getQuarantineKey()]);
    }
}
