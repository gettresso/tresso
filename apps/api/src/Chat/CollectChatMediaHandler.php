<?php

declare(strict_types=1);

namespace App\Chat;

use Symfony\Component\Messenger\Attribute\AsMessageHandler;

#[AsMessageHandler]
final readonly class CollectChatMediaHandler
{
    public function __construct(private ChatMediaCollector $collector)
    {
    }

    public function __invoke(CollectChatMedia $message): void
    {
        $this->collector->collect($message->objectKey);
    }
}
