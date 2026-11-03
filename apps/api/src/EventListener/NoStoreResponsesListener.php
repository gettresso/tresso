<?php

declare(strict_types=1);

namespace App\EventListener;

use Symfony\Component\EventDispatcher\Attribute\AsEventListener;
use Symfony\Component\HttpKernel\Event\ResponseEvent;
use Symfony\Component\HttpKernel\KernelEvents;

/**
 * Responses that can hold secrets must never be stored by any cache or proxy: everything under /internal (credentials,
 * leases) and the personal access tokens (the response that makes one holds its secret).
 */
#[AsEventListener(event: KernelEvents::RESPONSE)]
final class NoStoreResponsesListener
{
    private const array PATHS = ['/internal/', '/api/v1/personal-access-tokens'];

    public function __invoke(ResponseEvent $event): void
    {
        $path = $event->getRequest()->getPathInfo();
        $matches = array_filter(self::PATHS, static fn (string $prefix): bool => str_starts_with($path, $prefix));
        if ([] === $matches) {
            return;
        }

        $headers = $event->getResponse()->headers;
        $headers->set('Cache-Control', 'no-store, private');
        $headers->set('Pragma', 'no-cache');
    }
}
