<?php

declare(strict_types=1);

namespace App\Billing\Stripe;

use Psr\Clock\ClockInterface;
use Symfony\Component\DependencyInjection\Attribute\Autowire;

/**
 * Checks the Stripe-Signature header of a webhook: an HMAC-SHA256 of "timestamp.body" with the endpoint's signing
 * secret, made at most five minutes ago, so neither a forged nor a replayed request is taken for Stripe's.
 */
final readonly class WebhookSignature
{
    public const int TOLERANCE_SECONDS = 300;

    public function __construct(
        #[Autowire(env: 'STRIPE_WEBHOOK_SECRET')]
        #[\SensitiveParameter]
        private string $secret,
        private ClockInterface $clock,
    ) {
    }

    /**
     * The event in the body when the header proves Stripe sent it.
     *
     * @throws StripeException when it does not
     */
    public function verify(string $body, string $header): WebhookEvent
    {
        if ('' === trim($this->secret)) {
            throw new StripeException('STRIPE_WEBHOOK_SECRET is not set.');
        }

        $timestamp = null;
        $signatures = [];
        foreach (explode(',', $header) as $part) {
            [$key, $value] = array_pad(explode('=', trim($part), 2), 2, '');
            if ('t' === $key && 1 === preg_match('/^\d+$/', $value)) {
                $timestamp = (int) $value;
            } elseif ('v1' === $key) {
                $signatures[] = $value;
            }
        }
        if (null === $timestamp || [] === $signatures) {
            throw new StripeException('The Stripe-Signature header has no timestamp or signature.');
        }
        if (abs($this->clock->now()->getTimestamp() - $timestamp) > self::TOLERANCE_SECONDS) {
            throw new StripeException('The webhook was signed too long ago.');
        }

        $expected = hash_hmac('sha256', $timestamp.'.'.$body, $this->secret);
        $valid = false;
        foreach ($signatures as $signature) {
            $valid = hash_equals($expected, $signature) || $valid;
        }
        if (!$valid) {
            throw new StripeException('The webhook signature does not match.');
        }

        try {
            $event = json_decode($body, true, flags: \JSON_THROW_ON_ERROR);
        } catch (\JsonException $exception) {
            throw new StripeException('The webhook body is not JSON.', 0, $exception);
        }
        if (!\is_array($event) || !\is_string($event['id'] ?? null) || !\is_string($event['type'] ?? null)) {
            throw new StripeException('The webhook body is not a Stripe event.');
        }
        $data = \is_array($event['data'] ?? null) ? $event['data'] : [];

        return new WebhookEvent($event['id'], $event['type'], \is_array($data['object'] ?? null) ? $data['object'] : []);
    }
}
