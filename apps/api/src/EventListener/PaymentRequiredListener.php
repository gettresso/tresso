<?php

declare(strict_types=1);

namespace App\EventListener;

use App\Billing\PaymentWall;
use Symfony\Component\EventDispatcher\Attribute\AsEventListener;
use Symfony\Component\HttpKernel\Event\RequestEvent;
use Symfony\Component\HttpKernel\KernelEvents;

/**
 * Answers 402 Payment Required to a REST call of a user the {@see PaymentWall} blocks. Only on the main request: the
 * API operations an MCP tool runs as sub-requests ask the same wall in {@see \App\Mcp\Api}, and the error pages API
 * Platform renders as sub-requests must not be blocked.
 */
final readonly class PaymentRequiredListener
{
    public function __construct(private PaymentWall $wall)
    {
    }

    // After the firewall (priority 8), so the user is known.
    #[AsEventListener(event: KernelEvents::REQUEST, priority: 4)]
    public function onRequest(RequestEvent $event): void
    {
        if (!$event->isMainRequest()) {
            return;
        }
        $request = $event->getRequest();
        // Decoded as the router and access_control decode it, so /%61pi/... cannot slip past as something else.
        if ($this->wall->blocks($request->getMethod(), rawurldecode($request->getPathInfo()))) {
            $event->setResponse(PaymentWall::response());
        }
    }
}
