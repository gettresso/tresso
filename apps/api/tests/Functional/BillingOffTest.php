<?php

declare(strict_types=1);

namespace App\Tests\Functional;

/**
 * A server that does not bill (every self-hosted server): nothing is ever blocked, whatever a trial says.
 */
final class BillingOffTest extends DatabaseTestCase
{
    use AuthenticatesUsers;

    protected function setUp(): void
    {
        parent::setUp();
        $this->bootstrapOAuthClients();
        $this->createUser('kim@example.test', 'Kim Visser');
    }

    public function testNothingIsBlockedEvenAfterATrial(): void
    {
        $this->connection()->executeStatement("UPDATE billing_subscription SET trial_ends_at = NOW() - INTERVAL '1 year', status = 'canceled'");
        $headers = $this->userHeaders('kim@example.test', []);

        $this->client->request('GET', '/api/v1/me', server: $headers);
        self::assertResponseIsSuccessful();

        $this->client->request('GET', '/api/v1/billing', server: $headers);
        self::assertResponseIsSuccessful();
        self::assertFalse($this->decodedResponse()['enabled'] ?? null);
        self::assertTrue($this->decodedResponse()['entitled'] ?? null);
        self::assertSame([], $this->decodedResponse()['organizations'] ?? null);
    }

    public function testThereIsNothingToBuyAndNoWebhook(): void
    {
        $organizationId = $this->connection()->fetchOne('SELECT id FROM organization');

        $this->client->jsonRequest('POST', '/api/v1/billing/checkout', ['organizationId' => $organizationId, 'plan' => 'monthly'], $this->userHeaders('kim@example.test', []));
        self::assertResponseStatusCodeSame(404);

        $this->client->request('POST', '/billing/stripe/webhook', content: '{}');
        self::assertResponseStatusCodeSame(404);

        $this->client->request('GET', '/api/v1/server-info');
        self::assertResponseIsSuccessful();
        self::assertFalse($this->decodedResponse()['billing'] ?? null);
        self::assertSame(0, $this->decodedResponse()['trialDays'] ?? null);
    }
}
