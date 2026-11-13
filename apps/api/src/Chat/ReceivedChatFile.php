<?php

declare(strict_types=1);

namespace App\Chat;

/**
 * A file that arrived as a request body ({@see ChatFileBody}), in a temporary file the caller removes with
 * {@see discard()} once it is stored.
 */
final readonly class ReceivedChatFile
{
    public function __construct(
        public string $path,
        public int $size,
        /** Hex SHA-256 of the content. */
        public string $sha256,
        public string $contentType,
    ) {
    }

    /** @return resource */
    public function open(): mixed
    {
        return fopen($this->path, 'rb') ?: throw new \RuntimeException('The received file cannot be read.');
    }

    public function discard(): void
    {
        if (is_file($this->path)) {
            unlink($this->path);
        }
    }
}
