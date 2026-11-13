<?php

declare(strict_types=1);

namespace App\Chat;

use App\ApiResource\ChatMediaResource;
use App\Entity\ChatMessage;

/** A chat message's file as {@see ChatMediaResource} shows it. */
final readonly class ChatMediaViews
{
    public function __construct(
        private ChatFields $fields,
        private ChatMediaUrls $urls,
    ) {
    }

    /**
     * With $confirmed, a file that could not be scanned gets its link too (the user accepted that). Without $linked (a
     * caller that is not one of our own apps) there is never a link: files are for our own apps only, and a token's
     * `chat:read` covers what chats say, not the files people sent.
     */
    public function resource(ChatMessage $message, bool $confirmed, bool $linked = true): ChatMediaResource
    {
        return new ChatMediaResource(
            $message->getId()->toRfc4122(),
            $message->getMediaKind()->value ?? throw new \LogicException('A message with a file has a kind.'),
            $this->fields->mediaName($message),
            $message->getMediaStoredSize() ?? $message->getMediaSize(),
            $message->getMediaState()->value ?? throw new \LogicException('A message with a file has a state.'),
            $message->getMediaError()?->value,
            $this->urls->access($message)?->value,
            $linked ? $this->urls->forMessage($message, $confirmed) : null,
        );
    }
}
