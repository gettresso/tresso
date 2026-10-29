<?php

declare(strict_types=1);

namespace App\EventListener;

use App\Billing\Entitlements;
use App\Entity\User;
use Symfony\Bundle\SecurityBundle\Security;
use Symfony\Component\EventDispatcher\Attribute\AsEventListener;
use Symfony\Component\HttpFoundation\JsonResponse;
use Symfony\Component\HttpFoundation\Response;
use Symfony\Component\HttpKernel\Event\RequestEvent;
use Symfony\Component\HttpKernel\KernelEvents;

/**
 * On a server that bills, a user whose organizations are all past their trial without a subscription gets 402
 * Payment Required from every API call except billing itself and the server info, so an app can show the payment
 * screen and send them to Stripe. Signing in and out are outside /api and keep working; worker tokens carry no user
 * and are not affected (the sync leases leave such users' accounts alone instead).
 */
final readonly class PaymentRequiredListener
{
    /** Paths a blocked user can still reach. */
    public const array OPEN = ['/api/v1/billing', '/api/v1/billing/checkout', '/api/v1/billing/portal', '/api/v1/server-info'];

    public function __construct(
        private Security $security,
        private Entitlements $entitlements,
    ) {
    }

    // After the firewall (priority 8), so the user is known.
    #[AsEventListener(event: KernelEvents::REQUEST, priority: 4)]
    public function onRequest(RequestEvent $event): void
    {
        if (!$event->isMainRequest() || !$this->entitlements->billingEnabled()) {
            return;
        }
        // Decoded as the router and access_control decode it, so /%61pi/... cannot slip past as something else.
        $path = rawurldecode($event->getRequest()->getPathInfo());
        if (!str_starts_with($path, '/api/') || \in_array(rtrim($path, '/'), self::OPEN, true)) {
            return;
        }
        $user = $this->security->getUser();
        if (!$user instanceof User || $this->entitlements->allows($user->getId())) {
            return;
        }

        $event->setResponse(new JsonResponse([
            'type' => 'https://tresso.app/errors/payment-required',
            'title' => 'Payment Required',
            'status' => Response::HTTP_PAYMENT_REQUIRED,
            'detail' => 'The trial or subscription has ended. Open billing to subscribe.',
        ], Response::HTTP_PAYMENT_REQUIRED, ['Content-Type' => 'application/problem+json']));
    }
}
