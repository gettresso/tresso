<?php

declare(strict_types=1);

namespace App\Billing;

use App\Entity\User;
use Symfony\Bundle\SecurityBundle\Security;
use Symfony\Component\HttpFoundation\JsonResponse;
use Symfony\Component\HttpFoundation\Response;

/**
 * On a server that bills, a user whose organizations are all past their trial without a subscription gets 402
 * Payment Required from every API operation except billing itself and the server info, so an app can show the payment
 * screen and send them to Stripe. Signing in and out are outside /api and keep working; worker tokens carry no user
 * and are not affected (the sync leases leave such users' accounts alone instead).
 *
 * The one place that decides it: for REST calls ({@see \App\EventListener\PaymentRequiredListener}) and for the API
 * operations an MCP tool runs ({@see \App\Mcp\Api}), so a tool is blocked exactly when the REST call would be.
 */
final readonly class PaymentWall
{
    /** Paths a blocked user can still reach. */
    public const array OPEN = ['/api/v1/billing', '/api/v1/billing/checkout', '/api/v1/billing/portal', '/api/v1/server-info'];

    public const string DETAIL = 'The trial or subscription has ended. Open billing to subscribe.';

    /**
     * Signing out removes the device from the user's push devices (the web client finds its own by registering it
     * again first): that stays open, or a device signed out while blocked would get their notifications once renewed.
     */
    private const string SIGN_OUT_DEVICE = '{^/api/v1/notification-devices(/[^/]+)?$}';

    public function __construct(
        private Security $security,
        private Entitlements $entitlements,
    ) {
    }

    /**
     * Whether the signed-in user is refused this API call.
     *
     * @param string $path the path as the router matches it (decoded)
     */
    public function blocks(string $method, string $path): bool
    {
        if (!$this->entitlements->billingEnabled()) {
            return false;
        }
        if (!str_starts_with($path, '/api/') || \in_array(rtrim($path, '/'), self::OPEN, true)) {
            return false;
        }
        if (('DELETE' === $method || 'POST' === $method) && 1 === preg_match(self::SIGN_OUT_DEVICE, $path) && !str_ends_with($path, '/web-push-key')) {
            return false;
        }
        $user = $this->security->getUser();

        return $user instanceof User && !$this->entitlements->allows($user->getId());
    }

    public static function response(): JsonResponse
    {
        return new JsonResponse([
            'type' => 'https://gettresso.com/errors/payment-required',
            'title' => 'Payment Required',
            'status' => Response::HTTP_PAYMENT_REQUIRED,
            'detail' => self::DETAIL,
        ], Response::HTTP_PAYMENT_REQUIRED, ['Content-Type' => 'application/problem+json']);
    }
}
