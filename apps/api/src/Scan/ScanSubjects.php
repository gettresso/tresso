<?php

declare(strict_types=1);

namespace App\Scan;

use App\Entity\ChatMessage;
use App\Repository\AttachmentRepository;
use App\Repository\DraftAttachmentRepository;
use Doctrine\ORM\EntityManagerInterface;
use Symfony\Component\Uid\Uuid;

final readonly class ScanSubjects
{
    public function __construct(
        private AttachmentRepository $attachments,
        private DraftAttachmentRepository $draftAttachments,
        private EntityManagerInterface $entityManager,
    ) {
    }

    /**
     * Null when the attachment is gone (its message or draft was removed in the meantime), and for a chat message whose
     * file is not stored (any more).
     */
    public function find(ScanAttachment $message): ?ScanSubject
    {
        if (ScanTarget::Chat === $message->target) {
            $chatMessage = Uuid::isValid($message->attachmentId) ? $this->entityManager->find(ChatMessage::class, Uuid::fromString($message->attachmentId)) : null;

            return null === $chatMessage ? null : ScanSubject::ofChatMessage($chatMessage);
        }
        if (ScanTarget::Draft === $message->target) {
            $attachment = $this->draftAttachments->findById($message->attachmentId);

            return null === $attachment ? null : ScanSubject::ofDraftAttachment($attachment);
        }
        $attachment = $this->attachments->findById($message->attachmentId);

        return null === $attachment ? null : ScanSubject::ofAttachment($attachment);
    }
}
