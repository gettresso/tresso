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

    /** With $confirmed, a file that could not be scanned gets its link too (the user accepted that). */
    public function resource(ChatMessage $message, bool $confirmed): ChatMediaResource
    {
        return new ChatMediaResource(
            $message->getId()->toRfc4122(),
            $message->getMediaKind()->value ?? throw new \LogicException('A message with a file has a kind.'),
            $this->fields->mediaName($message),
            $message->getMediaStoredSize() ?? $message->getMediaSize(),
            $message->getMediaState()->value ?? throw new \LogicException('A message with a file has a state.'),
            $message->getMediaError()?->value,
            $this->urls->access($message)?->value,
            $this->urls->forMessage($message, $confirmed),
        );
    }
}
