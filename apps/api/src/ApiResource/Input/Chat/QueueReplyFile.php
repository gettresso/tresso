<?php

declare(strict_types=1);

namespace App\ApiResource\Input\Chat;

use Symfony\Component\Validator\Constraints as Assert;

/**
 * The file a reply carries: one the client uploaded to the chat before (`PUT /api/v1/chats/{chatId}/uploads/{id}`), and
 * the name it goes out under. Only our own apps attach files.
 */
final class QueueReplyFile
{
    public const int MAX_NAME = 255;

    #[Assert\NotBlank]
    #[Assert\Uuid(strict: false)]
    public string $uploadId = '';

    /** Without a folder: anything up to the last slash or backslash is dropped. */
    #[Assert\NotBlank(normalizer: 'trim', message: 'Name the file.')]
    #[Assert\Length(max: self::MAX_NAME, normalizer: 'trim')]
    #[Assert\Regex('/[\x00-\x1F\x7F]/', message: 'The file name cannot contain control characters.', match: false)]
    public string $name = '';

    /** The name it goes out under: its last part, without leading dots, or `file` when nothing is left. */
    public function cleanName(): string
    {
        $name = trim(basename(str_replace('\\', '/', $this->name)));
        $name = ltrim($name, '.');

        return '' === $name ? 'file' : mb_substr($name, 0, self::MAX_NAME);
    }
}
