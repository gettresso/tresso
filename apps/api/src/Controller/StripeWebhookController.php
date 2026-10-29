<?php

declare(strict_types=1);

namespace App\Controller;

use App\Billing\BillingSettings;
use App\Billing\Stripe\StripeException;
use App\Billing\Stripe\WebhookSignature;
use App\Billing\Subscriptions;
use Psr\Log\LoggerInterface;
use Symfony\Component\HttpFoundation\JsonResponse;
use Symfony\Component\HttpFoundation\Request;
use Symfony\Component\HttpFoundation\Response;
use Symfony\Component\Routing\Attribute\Route;

/**
 * Stripe's webhook. Only a signed request counts, and every event is handled once. A subscription change is taken
 * from the Stripe API, not from the event, so events may arrive in any order. A failure answers 500, and Stripe
 * delivers the event again later.
 */
final readonly class StripeWebhookController
{
    public function __construct(
        private BillingSettings $settings,
        private WebhookSignature $signature,
        private Subscriptions $subscriptions,
        private LoggerInterface $logger,
    ) {
    }

    #[Route('/billing/stripe/webhook', name: 'billing_stripe_webhook', methods: ['POST'])]
    public function __invoke(Request $request): Response
    {
        if (!$this->settings->enabled) {
            return new JsonResponse(['error' => 'This server does not bill.'], Response::HTTP_NOT_FOUND);
        }

        try {
            $event = $this->signature->verify($request->getContent(), (string) $request->headers->get('Stripe-Signature', ''));
        } catch (StripeException $exception) {
            return new JsonResponse(['error' => $exception->getMessage()], Response::HTTP_BAD_REQUEST);
        }

        try {
            $handled = $this->subscriptions->handle($event);
        } catch (StripeException $exception) {
            $this->logger->error('Stripe event {id} could not be handled: {message}', ['id' => $event->id, 'message' => $exception->getMessage()]);

            return new JsonResponse(['error' => 'Stripe could not be asked; try again.'], Response::HTTP_INTERNAL_SERVER_ERROR);
        }

        return new JsonResponse(['received' => true, 'duplicate' => !$handled]);
    }
}
