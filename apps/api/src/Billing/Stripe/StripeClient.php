<?php

declare(strict_types=1);

namespace App\Billing\Stripe;

use Symfony\Component\DependencyInjection\Attribute\Autowire;
use Symfony\Contracts\HttpClient\Exception\ExceptionInterface;
use Symfony\Contracts\HttpClient\HttpClientInterface;

/**
 * The few Stripe API calls billing needs, on one pinned API version so Stripe's answers keep their shape.
 */
final readonly class StripeClient
{
    public const string API = 'https://api.stripe.com/v1';
    public const string VERSION = '2025-03-31.basil';

    public function __construct(
        private HttpClientInterface $httpClient,
        #[Autowire(env: 'STRIPE_SECRET_KEY')]
        #[\SensitiveParameter]
        private string $secretKey,
    ) {
    }

    /** A customer for an organization, so invoices and the billing portal belong to it. */
    public function createCustomer(string $organizationId, string $name, string $email): string
    {
        $customer = $this->request('POST', '/customers', [
            'name' => $name,
            'email' => $email,
            'metadata' => ['organization_id' => $organizationId],
        ], 'customer-'.$organizationId);

        return self::id($customer);
    }

    /**
     * A Checkout page that subscribes the customer to the price for the organization's members, collecting the
     * billing address and VAT id so Stripe Tax can charge the right VAT.
     */
    public function createCheckoutSession(string $customerId, string $organizationId, string $priceId, int $quantity, string $successUrl, string $cancelUrl): string
    {
        $session = $this->request('POST', '/checkout/sessions', [
            'mode' => 'subscription',
            'customer' => $customerId,
            'client_reference_id' => $organizationId,
            'line_items' => [['price' => $priceId, 'quantity' => $quantity]],
            'subscription_data' => ['metadata' => ['organization_id' => $organizationId]],
            'automatic_tax' => ['enabled' => 'true'],
            'billing_address_collection' => 'required',
            'tax_id_collection' => ['enabled' => 'true'],
            'customer_update' => ['address' => 'auto', 'name' => 'auto'],
            'success_url' => $successUrl,
            'cancel_url' => $cancelUrl,
        ]);

        return self::url($session);
    }

    /** Stripe's own page where the customer changes the plan, the card or the invoices' details, or cancels. */
    public function createPortalSession(string $customerId, string $returnUrl): string
    {
        return self::url($this->request('POST', '/billing_portal/sessions', ['customer' => $customerId, 'return_url' => $returnUrl]));
    }

    public function subscription(string $id): StripeSubscription
    {
        if (1 !== preg_match('/^sub_[A-Za-z0-9]+$/', $id)) {
            throw new StripeException('That is not a Stripe subscription id.');
        }

        return StripeSubscription::fromApi($this->request('GET', '/subscriptions/'.$id));
    }

    /**
     * @param array<string, mixed> $form
     *
     * @return array<mixed>
     */
    private function request(string $method, string $path, array $form = [], ?string $idempotencyKey = null): array
    {
        if ('' === trim($this->secretKey)) {
            throw new StripeException('STRIPE_SECRET_KEY is not set.');
        }

        $headers = ['Stripe-Version' => self::VERSION];
        if (null !== $idempotencyKey) {
            $headers['Idempotency-Key'] = $idempotencyKey;
        }
        try {
            $response = $this->httpClient->request($method, self::API.$path, [
                'auth_bearer' => $this->secretKey,
                'headers' => $headers,
                'body' => [] === $form ? null : http_build_query($form, '', '&', \PHP_QUERY_RFC3986),
                'timeout' => 20,
            ]);
            $status = $response->getStatusCode();
            $body = $response->toArray(false);
        } catch (ExceptionInterface|\JsonException $exception) {
            throw new StripeException('Stripe could not be reached: '.$exception->getMessage(), 0, $exception);
        }

        if ($status >= 300) {
            $error = \is_array($body['error'] ?? null) ? $body['error'] : [];
            $message = \is_string($error['message'] ?? null) ? $error['message'] : 'no message';

            throw new StripeException(\sprintf('Stripe refused %s %s (%d): %s', $method, $path, $status, $message));
        }

        return $body;
    }

    /** @param array<mixed> $object */
    private static function id(array $object): string
    {
        $id = $object['id'] ?? null;
        if (!\is_string($id) || '' === $id) {
            throw new StripeException('Stripe answered without an id.');
        }

        return $id;
    }

    /** @param array<mixed> $object */
    private static function url(array $object): string
    {
        $url = $object['url'] ?? null;
        if (!\is_string($url) || !str_starts_with($url, 'https://')) {
            throw new StripeException('Stripe answered without a page address.');
        }

        return $url;
    }
}
