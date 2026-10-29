<?php

declare(strict_types=1);

namespace App\Tests\Functional;

use App\Entity\User;
use App\Enum\NotificationChannel;
use App\Notification\NotificationChannelChoice;
use App\Notification\NotificationDispatcher;
use App\Repository\UserRepository;

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

        $this->client->request('GET', '/api/v1/billing', server: $this->userHeaders('kim@example.test', ['settings:read']));
        self::assertResponseIsSuccessful();
        self::assertFalse($this->decodedResponse()['enabled'] ?? null);
        self::assertTrue($this->decodedResponse()['entitled'] ?? null);
        self::assertSame([], $this->decodedResponse()['organizations'] ?? null);
    }

    public function testSyncAndNotificationsCarryOnEvenAfterATrial(): void
    {
        $this->client->jsonRequest('POST', '/api/v1/mail-accounts', [
            'emailAddress' => 'kim@company.example',
            'displayName' => 'Work',
            'username' => 'kim@company.example',
            'password' => 'app-password-1',
            'imap' => ['host' => 'imap.company.example', 'port' => 993, 'security' => 'tls'],
            'smtp' => ['host' => 'smtp.company.example', 'port' => 465, 'security' => 'tls'],
        ], $this->userHeaders('kim@example.test', ['settings:write']));
        self::assertResponseStatusCodeSame(201);
        $this->connection()->executeStatement("UPDATE billing_subscription SET trial_ends_at = NOW() - INTERVAL '1 year', status = 'canceled'");

        $this->client->jsonRequest('POST', '/internal/sync/leases', ['workerId' => 'w1'], $this->workerHeaders('sync:lease'));
        self::assertResponseIsSuccessful();
        $accounts = $this->decodedResponse()['accounts'] ?? null;
        self::assertIsArray($accounts);
        self::assertCount(1, $accounts);

        $kim = static::getContainer()->get(UserRepository::class)->findOneBy(['email' => 'kim@example.test']);
        self::assertInstanceOf(User::class, $kim);
        self::assertNotSame([], static::getContainer()->get(NotificationDispatcher::class)->claim($kim, 'test:1', new NotificationChannelChoice(NotificationChannel::Email), true));
    }

    public function testThereIsNothingToBuyAndNoWebhook(): void
    {
        $organizationId = $this->connection()->fetchOne('SELECT id FROM organization');

        $this->client->jsonRequest('POST', '/api/v1/billing/checkout', ['organizationId' => $organizationId, 'plan' => 'monthly'], $this->userHeaders('kim@example.test', ['settings:write']));
        self::assertResponseStatusCodeSame(404);

        $this->client->request('POST', '/billing/stripe/webhook', content: '{}');
        self::assertResponseStatusCodeSame(404);

        $this->client->request('GET', '/api/v1/server-info');
        self::assertResponseIsSuccessful();
        self::assertFalse($this->decodedResponse()['billing'] ?? null);
        self::assertSame(0, $this->decodedResponse()['trialDays'] ?? null);
    }
}
