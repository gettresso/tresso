<?php

declare(strict_types=1);

namespace App\Entity;

use App\Repository\ChatUploadRepository;
use Doctrine\DBAL\Types\Types;
use Doctrine\ORM\Mapping as ORM;
use Symfony\Bridge\Doctrine\Types\UuidType;
use Symfony\Component\Uid\Uuid;

/**
 * A file a browser or phone uploaded for a reply it is about to queue ({@see \App\Chat\ChatUploads}). The reply takes it
 * over when it is queued ({@see ChatOutgoing::attachFile()}) and this row goes; one nobody queued is removed after
 * {@see \App\Chat\ChatUploads::KEEP_UNQUEUED} with its file. The content is sealed with the owner's key under
 * {@see \App\Storage\BlobKind::ChatMedia}; its name comes with the reply, so nothing here says what the file is called.
 *
 * Never sent to clients: an upload is nothing they show until a reply carries it.
 */
#[ORM\Entity(repositoryClass: ChatUploadRepository::class)]
#[ORM\Index(name: 'chat_upload_chat', columns: ['chat_id'])]
#[ORM\Index(name: 'chat_upload_created', columns: ['created_at'])]
#[ORM\Index(name: 'chat_upload_sha', columns: ['sha256'])]
class ChatUpload
{
    #[ORM\Id]
    #[ORM\Column(type: UuidType::NAME)]
    private Uuid $id;

    #[ORM\ManyToOne]
    #[ORM\JoinColumn(nullable: false, onDelete: 'CASCADE')]
    private Chat $chat;

    #[ORM\ManyToOne]
    #[ORM\JoinColumn(nullable: false, onDelete: 'CASCADE')]
    private ChatAccount $chatAccount;

    #[ORM\Column(length: 255)]
    private string $objectKey;

    #[ORM\Column]
    private int $keyVersion;

    /** The owner's fingerprint of the content. */
    #[ORM\Column(length: 64)]
    private string $sha256;

    #[ORM\Column(type: Types::BIGINT)]
    private int $size;

    #[ORM\Column(length: 255)]
    private string $contentType;

    #[ORM\Column]
    private \DateTimeImmutable $createdAt;

    /** $id comes from the client, so an upload sent again names the same one. */
    public function __construct(Uuid $id, Chat $chat, string $objectKey, int $keyVersion, string $sha256, int $size, string $contentType, \DateTimeImmutable $now)
    {
        $this->id = $id;
        $this->chat = $chat;
        $this->chatAccount = $chat->getChatAccount();
        $this->objectKey = $objectKey;
        $this->keyVersion = $keyVersion;
        $this->sha256 = $sha256;
        $this->size = $size;
        $this->contentType = $contentType;
        $this->createdAt = $now;
    }

    public function getId(): Uuid
    {
        return $this->id;
    }

    public function getChat(): Chat
    {
        return $this->chat;
    }

    public function getChatAccount(): ChatAccount
    {
        return $this->chatAccount;
    }

    public function getObjectKey(): string
    {
        return $this->objectKey;
    }

    public function getKeyVersion(): int
    {
        return $this->keyVersion;
    }

    public function getSha256(): string
    {
        return $this->sha256;
    }

    public function getSize(): int
    {
        return $this->size;
    }

    public function getContentType(): string
    {
        return $this->contentType;
    }

    public function getCreatedAt(): \DateTimeImmutable
    {
        return $this->createdAt;
    }
}
