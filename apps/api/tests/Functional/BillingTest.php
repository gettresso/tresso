<?php

declare(strict_types=1);

namespace App\Tests\Functional;

use App\Billing\Stripe\StripeClient;
use App\Billing\Subscriptions;
use App\Entity\User;
use App\Enum\NotificationChannel;
use App\Notification\NotificationChannelChoice;
use App\Notification\NotificationDispatcher;
use App\Tests\Support\MockHttpRouter;
use Doctrine\DBAL\Exception as DBALException;
use Symfony\Bundle\FrameworkBundle\Console\Application;
use Symfony\Component\Console\Tester\CommandTester;

/**
 * Billing on a server that bills (TRESSO_BILLING=1, as Tresso Cloud): the trial, the block when it is over, Checkout
 * and the portal, and the Stripe webhook that follows the subscription.
 */
final class BillingTest extends DatabaseTestCase
{
    use AuthenticatesUsers;

    private const string WEBHOOK_SECRET = 'whsec_billingtest';
    private const array SETTINGS = [
        'TRESSO_BILLING' => '1',
        'STRIPE_SECRET_KEY' => 'sk_test_billingtest',
        'STRIPE_WEBHOOK_SECRET' => self::WEBHOOK_SECRET,
        'STRIPE_PRICE_MONTHLY' => 'price_monthly',
        'STRIPE_PRICE_YEARLY' => '',
    ];

    /** @var array<string, array{mixed, mixed}> */
    private array $previous = [];

    private User $kim;

    protected function setUp(): void
    {
        foreach (self::SETTINGS as $name => $value) {
            $this->previous[$name] = [$_SERVER[$name] ?? null, $_ENV[$name] ?? null];
            $_SERVER[$name] = $_ENV[$name] = $value;
        }
        parent::setUp();
        $this->bootstrapOAuthClients();
        $this->kim = $this->createUser('kim@example.test', 'Kim Visser');
        $this->createUser('lisa@example.test', 'Lisa Bakker');
    }

    protected function tearDown(): void
    {
        parent::tearDown();
        foreach ($this->previous as $name => [$server, $env]) {
            if (null === $server) {
                unset($_SERVER[$name]);
            } else {
                $_SERVER[$name] = $server;
            }
            if (null === $env) {
                unset($_ENV[$name]);
            } else {
                $_ENV[$name] = $env;
            }
        }
    }

    public function testANewAccountWorksDuringItsTrial(): void
    {
        $this->client->request('GET', '/api/v1/me', server: $this->kimHeaders());
        self::assertResponseIsSuccessful();

        $billing = $this->billing();
        self::assertTrue($billing['enabled'] ?? null);
        self::assertTrue($billing['entitled'] ?? null);
        self::assertSame(['monthly'], $billing['plans'] ?? null);
        $organization = $this->firstOrganization($billing);
        self::assertSame('trial', $organization['status'] ?? null);
        self::assertTrue($organization['personal'] ?? null);
        self::assertTrue($organization['canManage'] ?? null);
        self::assertIsString($organization['trialEndsAt'] ?? null);
        self::assertEqualsWithDelta(new \DateTimeImmutable('+14 days')->getTimestamp(), new \DateTimeImmutable($organization['trialEndsAt'])->getTimestamp(), 60);
    }

    public function testAfterTheTrialEverythingButBillingAnswersPaymentRequired(): void
    {
        $this->endTrial();

        $this->client->request('GET', '/api/v1/me', server: $this->kimHeaders());
        self::assertResponseStatusCodeSame(402);
        self::assertSame('application/problem+json', $this->client->getResponse()->headers->get('Content-Type'));
        self::assertSame(402, $this->decodedResponse()['status'] ?? null);

        $this->client->request('GET', '/api/v1/organizations', server: $this->kimHeaders());
        self::assertResponseStatusCodeSame(402);

        self::assertFalse($this->billing()['entitled'] ?? null, 'Billing stays open, so the app can show the payment screen.');
        $this->client->request('GET', '/api/v1/server-info');
        self::assertResponseIsSuccessful();

        $this->client->request('GET', '/api/v1/me', server: $this->userHeaders('lisa@example.test', []));
        self::assertResponseIsSuccessful('Lisa is still in her own trial.');
    }

    public function testTheServerSaysItBills(): void
    {
        $this->client->request('GET', '/api/v1/server-info');

        self::assertResponseIsSuccessful();
        self::assertSame(['product' => 'tresso-server', 'apiVersion' => 1, 'billing' => true, 'trialDays' => 14], array_intersect_key($this->decodedResponse(), array_flip(['product', 'apiVersion', 'billing', 'trialDays'])));
    }

    public function testCheckoutMakesACustomerAndAPageForEveryMember(): void
    {
        $router = $this->router();
        $router->respond(StripeClient::API.'/customers', (string) json_encode(['id' => 'cus_kim']));
        $router->respond(StripeClient::API.'/checkout/sessions', (string) json_encode(['id' => 'cs_1', 'url' => 'https://checkout.stripe.com/c/pay/cs_1']));
        $router->respond(StripeClient::API.'/subscriptions', (string) json_encode(['data' => []]));
        $organizationId = $this->firstOrganization($this->billing())['id'] ?? null;

        $this->client->jsonRequest('POST', '/api/v1/billing/checkout', ['organizationId' => $organizationId, 'plan' => 'monthly'], $this->kimHeaders());

        self::assertResponseIsSuccessful();
        self::assertSame('https://checkout.stripe.com/c/pay/cs_1', $this->responseString('url'));
        $customer = $router->requestsTo(StripeClient::API.'/customers')[0] ?? null;
        self::assertIsArray($customer);
        self::assertContains('Authorization: Bearer sk_test_billingtest', $customer['headers']);
        self::assertContains('Stripe-Version: '.StripeClient::VERSION, $customer['headers']);
        parse_str($customer['body'], $customerForm);
        self::assertSame('kim@example.test', $customerForm['email'] ?? null);
        $session = $router->requestsTo(StripeClient::API.'/checkout/sessions')[0] ?? null;
        self::assertIsArray($session);
        parse_str($session['body'], $form);
        self::assertSame('subscription', $form['mode'] ?? null);
        self::assertSame('cus_kim', $form['customer'] ?? null);
        self::assertSame([['price' => 'price_monthly', 'quantity' => '1']], $form['line_items'] ?? null);
        self::assertSame(['enabled' => 'true'], $form['automatic_tax'] ?? null);
        self::assertSame(['metadata' => ['organization_id' => $organizationId]], $form['subscription_data'] ?? null);
        self::assertStringEndsWith('/settings/billing?checkout=done', \is_string($form['success_url'] ?? null) ? $form['success_url'] : '');

        $this->client->jsonRequest('POST', '/api/v1/billing/checkout', ['organizationId' => $organizationId, 'plan' => 'monthly'], $this->kimHeaders());
        self::assertResponseIsSuccessful();
        self::assertCount(1, $router->requestsTo(StripeClient::API.'/customers'), 'The organization keeps its customer.');
    }

    public function testCheckoutAndPortalOnlyForAnOwnerOrAdminOfTheirOwnOrganization(): void
    {
        $kims = $this->firstOrganization($this->billing())['id'] ?? null;

        $this->client->jsonRequest('POST', '/api/v1/billing/checkout', ['organizationId' => $kims, 'plan' => 'monthly'], $this->userHeaders('lisa@example.test', ['settings:write']));
        self::assertResponseStatusCodeSame(404);

        $this->connection()->executeStatement(
            "INSERT INTO organization_member (id, role, joined_at, organization_id, user_id) SELECT uuidv7(), 'member', NOW(), :organization, id FROM app_user WHERE email = 'lisa@example.test'",
            ['organization' => $kims],
        );
        $this->client->jsonRequest('POST', '/api/v1/billing/checkout', ['organizationId' => $kims, 'plan' => 'monthly'], $this->userHeaders('lisa@example.test', ['settings:write']));
        self::assertResponseStatusCodeSame(403);

        $this->client->jsonRequest('POST', '/api/v1/billing/checkout', ['organizationId' => $kims, 'plan' => 'yearly'], $this->kimHeaders());
        self::assertResponseStatusCodeSame(422, 'This server sells no yearly plan.');

        $this->client->jsonRequest('POST', '/api/v1/billing/portal', ['organizationId' => $kims], $this->kimHeaders());
        self::assertResponseStatusCodeSame(422, 'Nothing to manage before a subscription.');
    }

    public function testAnEncodedPathIsBlockedToo(): void
    {
        $this->endTrial();

        foreach (['/%61pi/v1/me', '/api/v1/%6De', '/api/v1/organization%73'] as $path) {
            $this->client->request('GET', $path, server: $this->kimHeaders());
            self::assertResponseStatusCodeSame(402, $path);
        }
    }

    public function testPayingAndManagingNeedTheSettingsScopes(): void
    {
        $organizationId = $this->firstOrganization($this->billing())['id'] ?? null;

        $this->client->jsonRequest('POST', '/api/v1/billing/portal', ['organizationId' => $organizationId], $this->userHeaders('kim@example.test', ['mail:read']));
        self::assertResponseStatusCodeSame(403);
        $this->client->request('GET', '/api/v1/billing', server: $this->userHeaders('kim@example.test', ['mail:read']));
        self::assertResponseStatusCodeSame(403);
    }

    public function testASubscribedOrganizationCannotCheckOutTwice(): void
    {
        $organizationId = $this->firstOrganization($this->billing())['id'] ?? null;
        self::assertIsString($organizationId);
        $this->stripeHas('sub_kim', 'active', $organizationId, 1);
        $this->webhook('evt_1', 'customer.subscription.created', ['id' => 'sub_kim']);

        $this->client->jsonRequest('POST', '/api/v1/billing/checkout', ['organizationId' => $organizationId, 'plan' => 'monthly'], $this->kimHeaders());

        self::assertResponseStatusCodeSame(409);
        self::assertSame([], $this->router()->requestsTo(StripeClient::API.'/checkout/sessions'));
    }

    public function testCheckoutIsRefusedWhenStripeAlreadyHasASubscriptionWhoseEventsAreLate(): void
    {
        $organizationId = $this->firstOrganization($this->billing())['id'] ?? null;
        self::assertIsString($organizationId);
        $this->connection()->executeStatement("UPDATE billing_subscription SET stripe_customer_id = 'cus_kim' WHERE organization_id = :id", ['id' => $organizationId]);
        $this->router()->respond(StripeClient::API.'/subscriptions', (string) json_encode(['data' => [
            ['id' => 'sub_kim', 'customer' => 'cus_kim', 'status' => 'active', 'metadata' => ['organization_id' => $organizationId], 'items' => ['data' => [['quantity' => 1]]]],
        ]]));

        $this->client->jsonRequest('POST', '/api/v1/billing/checkout', ['organizationId' => $organizationId, 'plan' => 'monthly'], $this->kimHeaders());

        self::assertResponseStatusCodeSame(409);
        self::assertSame([], $this->router()->requestsTo(StripeClient::API.'/checkout/sessions'));
        self::assertSame('active', $this->firstOrganization($this->billing())['status'] ?? null, 'It now follows that subscription.');
    }

    public function testTheNightlyCheckCarriesOnAfterAFailure(): void
    {
        $this->connection()->executeStatement("UPDATE billing_subscription SET stripe_customer_id = 'cus_' || replace(organization_id::text, '-', '')");
        $this->router()->respond(StripeClient::API.'/subscriptions', '', 500);

        $tester = new CommandTester(new Application($this->client->getKernel())->find('app:billing:reconcile'));
        $tester->execute([]);

        self::assertSame(1, $tester->getStatusCode(), $tester->getDisplay());
        self::assertStringContainsString('0 subscriptions; 2 could not', preg_replace('/\s+/', ' ', $tester->getDisplay()) ?? '');
    }

    public function testTheNightlyCheckNeverLeavesATransactionOpen(): void
    {
        $organizationId = $this->firstOrganization($this->billing())['id'] ?? null;
        $this->connection()->executeStatement("UPDATE billing_subscription SET stripe_customer_id = 'cus_kim' WHERE organization_id = :id", ['id' => $organizationId]);
        // Seats beyond what the column holds: the flush fails with a database error, not a Stripe one.
        $this->router()->respond(StripeClient::API.'/subscriptions', (string) json_encode(['data' => [
            ['id' => 'sub_kim', 'customer' => 'cus_kim', 'status' => 'active', 'items' => ['data' => [['quantity' => 3_000_000_000]]]],
        ]]));
        $level = $this->connection()->getTransactionNestingLevel();

        try {
            static::getContainer()->get(Subscriptions::class)->reconcile();
            self::fail('The database error is raised.');
        } catch (DBALException) {
        }

        self::assertSame($level, $this->connection()->getTransactionNestingLevel());
    }

    public function testALateEventAboutAnOldSubscriptionKeepsTheNewOne(): void
    {
        $organizationId = $this->firstOrganization($this->billing())['id'] ?? null;
        self::assertIsString($organizationId);
        $this->endTrial();
        $this->stripeHas('sub_new', 'active', $organizationId, 1);
        $this->webhook('evt_1', 'customer.subscription.created', ['id' => 'sub_new']);

        $this->stripeHas('sub_old', 'canceled', $organizationId, 1);
        $this->webhook('evt_2', 'customer.subscription.deleted', ['id' => 'sub_old']);

        self::assertResponseIsSuccessful();
        $organization = $this->firstOrganization($this->billing());
        self::assertSame('active', $organization['status'] ?? null);
        $this->client->request('GET', '/api/v1/me', server: $this->kimHeaders());
        self::assertResponseIsSuccessful();
    }

    public function testADeletedCustomerIsForgotten(): void
    {
        $organizationId = $this->firstOrganization($this->billing())['id'] ?? null;
        self::assertIsString($organizationId);
        $this->stripeHas('sub_kim', 'active', $organizationId, 1);
        $this->webhook('evt_1', 'customer.subscription.created', ['id' => 'sub_kim']);

        $this->webhook('evt_2', 'customer.deleted', ['id' => 'cus_kim']);

        self::assertResponseIsSuccessful();
        self::assertSame([null, null], array_values((array) $this->connection()->fetchAssociative('SELECT stripe_customer_id, stripe_subscription_id FROM billing_subscription WHERE organization_id = :id', ['id' => $organizationId])));
        $this->client->request('GET', '/api/v1/me', server: $this->kimHeaders());
        self::assertResponseIsSuccessful('Still within the trial.');
    }

    public function testALateEventDoesNotLinkADeletedCustomerAgain(): void
    {
        $organizationId = $this->firstOrganization($this->billing())['id'] ?? null;
        self::assertIsString($organizationId);
        $this->stripeHas('sub_kim', 'active', $organizationId, 1);
        $this->webhook('evt_1', 'customer.subscription.created', ['id' => 'sub_kim']);
        $this->webhook('evt_2', 'customer.deleted', ['id' => 'cus_kim']);

        $this->stripeHas('sub_kim', 'canceled', $organizationId, 1);
        $this->webhook('evt_3', 'customer.subscription.deleted', ['id' => 'sub_kim']);

        self::assertResponseIsSuccessful();
        self::assertSame([null, null], array_values((array) $this->connection()->fetchAssociative('SELECT stripe_customer_id, stripe_subscription_id FROM billing_subscription WHERE organization_id = :id', ['id' => $organizationId])));
    }

    public function testAnUnpaidOrPausedSubscriptionAlsoBlocksASecondCheckout(): void
    {
        $organizationId = $this->firstOrganization($this->billing())['id'] ?? null;
        self::assertIsString($organizationId);
        foreach (['unpaid', 'paused', 'incomplete'] as $status) {
            $this->connection()->executeStatement("UPDATE billing_subscription SET stripe_customer_id = 'cus_kim', stripe_subscription_id = 'sub_kim', status = :status WHERE organization_id = :id", ['status' => $status, 'id' => $organizationId]);

            $this->client->jsonRequest('POST', '/api/v1/billing/checkout', ['organizationId' => $organizationId, 'plan' => 'monthly'], $this->kimHeaders());

            self::assertResponseStatusCodeSame(409, $status);
        }
    }

    public function testTheNightlyCheckKeepsACustomerStripeSaysItDoesNotHave(): void
    {
        $organizationId = $this->firstOrganization($this->billing())['id'] ?? null;
        $this->connection()->executeStatement("UPDATE billing_subscription SET stripe_customer_id = 'cus_kim', stripe_subscription_id = 'sub_kim', status = 'active' WHERE organization_id = :id", ['id' => $organizationId]);
        $this->router()->respond(StripeClient::API.'/subscriptions', (string) json_encode(['error' => ['message' => 'No such customer']]), 404);

        $tester = new CommandTester(new Application($this->client->getKernel())->find('app:billing:reconcile'));
        $tester->execute([]);

        self::assertSame(1, $tester->getStatusCode(), 'Reported as failed.');
        self::assertSame(['cus_kim', 'sub_kim', 'active'], array_values((array) $this->connection()->fetchAssociative('SELECT stripe_customer_id, stripe_subscription_id, status FROM billing_subscription WHERE organization_id = :id', ['id' => $organizationId])));
    }

    public function testAStripeRefusalIsNotCalledUnreachable(): void
    {
        $this->router()->respond(StripeClient::API.'/customers', (string) json_encode(['error' => ['message' => 'Invalid API Key provided']]), 401);
        $organizationId = $this->firstOrganization($this->billing())['id'] ?? null;

        $this->client->jsonRequest('POST', '/api/v1/billing/checkout', ['organizationId' => $organizationId, 'plan' => 'monthly'], $this->kimHeaders());

        self::assertResponseStatusCodeSame(502);
        self::assertStringNotContainsString('sk_test_billingtest', (string) $this->client->getResponse()->getContent());
    }

    public function testTheTrialGivesAccessEvenAfterACanceledSubscription(): void
    {
        $organizationId = $this->firstOrganization($this->billing())['id'] ?? null;
        self::assertIsString($organizationId);
        $this->stripeHas('sub_kim', 'canceled', $organizationId, 1);
        $this->webhook('evt_1', 'customer.subscription.deleted', ['id' => 'sub_kim']);

        $this->client->request('GET', '/api/v1/me', server: $this->kimHeaders());
        self::assertResponseIsSuccessful();
    }

    public function testATeamThatPaysGivesAccessWhenTheOwnTrialIsOver(): void
    {
        $this->endTrial();
        $team = $this->connection()->fetchOne("INSERT INTO organization (id, name, created_at) VALUES (uuidv7(), 'Support', NOW()) RETURNING id");
        $this->connection()->executeStatement(
            "INSERT INTO organization_member (id, role, joined_at, organization_id, user_id) VALUES (uuidv7(), 'member', NOW(), :team, :user)",
            ['team' => $team, 'user' => $this->kim->getId()->toRfc4122()],
        );
        $this->connection()->executeStatement(
            "INSERT INTO billing_subscription (id, organization_id, status, trial_ends_at, stripe_customer_id, stripe_subscription_id, seats, updated_at)
             VALUES (uuidv7(), :team, 'active', NOW() - INTERVAL '30 days', 'cus_team', 'sub_team', 3, NOW())",
            ['team' => $team],
        );

        $this->client->request('GET', '/api/v1/me', server: $this->kimHeaders());
        self::assertResponseIsSuccessful();
        $billing = $this->billing();
        self::assertTrue($billing['entitled'] ?? null);
        self::assertSame([false, true], array_column(\is_array($billing['organizations'] ?? null) ? $billing['organizations'] : [], 'entitled'));
    }

    public function testTheNightlyCheckFindsAFirstCheckoutWhoseEventsWereLost(): void
    {
        $organizationId = $this->firstOrganization($this->billing())['id'] ?? null;
        self::assertIsString($organizationId);
        $this->endTrial();
        $this->connection()->executeStatement("UPDATE billing_subscription SET stripe_customer_id = 'cus_kim' WHERE organization_id = :id", ['id' => $organizationId]);
        $this->router()->respond(StripeClient::API.'/subscriptions', (string) json_encode(['data' => [
            ['id' => 'sub_old', 'customer' => 'cus_kim', 'status' => 'canceled', 'items' => ['data' => [['quantity' => 1]]]],
            ['id' => 'sub_kim', 'customer' => 'cus_kim', 'status' => 'active', 'items' => ['data' => [['quantity' => 1, 'current_period_end' => 1796083200]]]],
        ]]));

        $tester = new CommandTester(new Application($this->client->getKernel())->find('app:billing:reconcile'));
        $tester->execute([]);

        $tester->assertCommandIsSuccessful();
        self::assertSame(['sub_kim', 'active'], array_values((array) $this->connection()->fetchAssociative('SELECT stripe_subscription_id, status FROM billing_subscription WHERE organization_id = :id', ['id' => $organizationId])));
        $this->client->request('GET', '/api/v1/me', server: $this->kimHeaders());
        self::assertResponseIsSuccessful();
    }

    public function testTurningBillingOnRestartsTheTrials(): void
    {
        $this->endTrial();

        $tester = new CommandTester(new Application($this->client->getKernel())->find('app:billing:restart-trials'));
        $tester->execute([]);

        $tester->assertCommandIsSuccessful();
        $this->client->request('GET', '/api/v1/me', server: $this->kimHeaders());
        self::assertResponseIsSuccessful();
    }

    public function testTheWebhookTakesTheSubscriptionFromStripe(): void
    {
        $organizationId = $this->firstOrganization($this->billing())['id'] ?? null;
        self::assertIsString($organizationId);
        $this->endTrial();
        $this->stripeHas('sub_kim', 'active', $organizationId, 1);

        $this->webhook('evt_1', 'customer.subscription.updated', ['id' => 'sub_kim', 'status' => 'incomplete']);

        self::assertResponseIsSuccessful();
        self::assertFalse($this->decodedResponse()['duplicate'] ?? null);
        $organization = $this->firstOrganization($this->billing());
        self::assertSame('active', $organization['status'] ?? null, 'The status is Stripe\'s now, not the event\'s.');
        self::assertSame(1, $organization['seats'] ?? null);
        self::assertSame('2026-12-01T00:00:00+00:00', $organization['currentPeriodEnd'] ?? null);
        $this->client->request('GET', '/api/v1/me', server: $this->kimHeaders());
        self::assertResponseIsSuccessful();
    }

    public function testAnEventIsHandledOnce(): void
    {
        $organizationId = $this->firstOrganization($this->billing())['id'] ?? null;
        self::assertIsString($organizationId);
        $this->stripeHas('sub_kim', 'active', $organizationId, 1);

        $this->webhook('evt_1', 'invoice.paid', ['id' => 'in_1', 'parent' => ['subscription_details' => ['subscription' => 'sub_kim']]]);
        $asked = \count($this->router()->requestsTo(StripeClient::API.'/subscriptions/sub_kim'));
        $this->webhook('evt_1', 'invoice.paid', ['id' => 'in_1', 'parent' => ['subscription_details' => ['subscription' => 'sub_kim']]]);

        self::assertResponseIsSuccessful();
        self::assertTrue($this->decodedResponse()['duplicate'] ?? null);
        self::assertGreaterThan(0, $asked);
        self::assertCount($asked, $this->router()->requestsTo(StripeClient::API.'/subscriptions/sub_kim'), 'A repeat asks Stripe nothing.');
    }

    public function testAPaymentStripeIsRetryingKeepsAccessAndACanceledOneEndsIt(): void
    {
        $organizationId = $this->firstOrganization($this->billing())['id'] ?? null;
        self::assertIsString($organizationId);
        $this->endTrial();

        $this->stripeHas('sub_kim', 'past_due', $organizationId, 1);
        $this->webhook('evt_1', 'invoice.payment_failed', ['id' => 'in_1', 'subscription' => 'sub_kim']);
        $this->client->request('GET', '/api/v1/me', server: $this->kimHeaders());
        self::assertResponseIsSuccessful('Stripe is still retrying the payment.');

        $this->stripeHas('sub_kim', 'canceled', $organizationId, 1);
        $this->webhook('evt_2', 'customer.subscription.deleted', ['id' => 'sub_kim']);
        $this->client->request('GET', '/api/v1/me', server: $this->kimHeaders());
        self::assertResponseStatusCodeSame(402);
    }

    public function testAnUnsignedOrStaleWebhookIsRefused(): void
    {
        $body = (string) json_encode(['id' => 'evt_1', 'type' => 'customer.subscription.updated', 'data' => ['object' => ['id' => 'sub_x']]]);

        $this->client->request('POST', '/billing/stripe/webhook', server: ['HTTP_STRIPE_SIGNATURE' => 't='.time().',v1='.hash_hmac('sha256', time().'.'.$body, 'whsec_wrong')], content: $body);
        self::assertResponseStatusCodeSame(400);

        $old = time() - 600;
        $this->client->request('POST', '/billing/stripe/webhook', server: ['HTTP_STRIPE_SIGNATURE' => 't='.$old.',v1='.hash_hmac('sha256', $old.'.'.$body, self::WEBHOOK_SECRET)], content: $body);
        self::assertResponseStatusCodeSame(400);

        self::assertSame(0, $this->countRows('SELECT COUNT(*) FROM billing_stripe_event'));
    }

    public function testSyncSkipsTheAccountsOfABlockedUser(): void
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
        $worker = $this->workerHeaders('sync:lease');

        $this->endTrial();
        self::assertSame(0, $this->leasedAccounts($worker));

        $this->connection()->executeStatement("UPDATE billing_subscription SET status = 'active', stripe_subscription_id = 'sub_kim' WHERE organization_id = (SELECT id FROM organization WHERE personal_owner_id = :user)", ['user' => $this->kim->getId()->toRfc4122()]);
        self::assertSame(1, $this->leasedAccounts($worker));
    }

    public function testABlockedUserGetsNoNotifications(): void
    {
        $dispatcher = static::getContainer()->get(NotificationDispatcher::class);
        $email = new NotificationChannelChoice(NotificationChannel::Email);
        self::assertNotSame([], $dispatcher->claim($this->kim, 'test:1', $email, true));

        $this->endTrial();

        self::assertSame([], $dispatcher->claim($this->kim, 'test:2', $email, true));
    }

    public function testTheNightlyCheckFollowsEverySubscription(): void
    {
        $organizationId = $this->firstOrganization($this->billing())['id'] ?? null;
        self::assertIsString($organizationId);
        $this->connection()->executeStatement("UPDATE billing_subscription SET stripe_customer_id = 'cus_kim', stripe_subscription_id = 'sub_kim', status = 'active' WHERE organization_id = :organization", ['organization' => $organizationId]);
        $this->router()->respond(StripeClient::API.'/subscriptions', (string) json_encode(['data' => [
            ['id' => 'sub_kim', 'customer' => 'cus_kim', 'status' => 'unpaid', 'items' => ['data' => [['quantity' => 1]]]],
        ]]));

        $tester = new CommandTester(new Application($this->client->getKernel())->find('app:billing:reconcile'));
        $tester->execute([]);

        $tester->assertCommandIsSuccessful();
        self::assertSame('unpaid', $this->connection()->fetchOne('SELECT status FROM billing_subscription WHERE stripe_subscription_id = :id', ['id' => 'sub_kim']));
    }

    /** @param array<string, string> $worker */
    private function leasedAccounts(array $worker): int
    {
        $this->client->jsonRequest('POST', '/internal/sync/leases', ['workerId' => 'w1'], $worker);
        self::assertResponseIsSuccessful();
        $accounts = $this->decodedResponse()['accounts'] ?? null;
        self::assertIsArray($accounts);

        return \count($accounts);
    }

    /** @return array<string, string> */
    private function kimHeaders(): array
    {
        return $this->userHeaders('kim@example.test', ['settings:read', 'settings:write']);
    }

    /** @return array<mixed> */
    private function billing(): array
    {
        $this->client->request('GET', '/api/v1/billing', server: $this->kimHeaders());
        self::assertResponseIsSuccessful();

        return $this->decodedResponse();
    }

    /**
     * @param array<mixed> $billing
     *
     * @return array<mixed>
     */
    private function firstOrganization(array $billing): array
    {
        $organizations = $billing['organizations'] ?? null;
        self::assertIsArray($organizations);
        $first = $organizations[0] ?? null;
        self::assertIsArray($first);

        return $first;
    }

    private function endTrial(): void
    {
        $this->connection()->executeStatement(
            "UPDATE billing_subscription SET trial_ends_at = NOW() - INTERVAL '1 day' WHERE organization_id = (SELECT id FROM organization WHERE personal_owner_id = :user)",
            ['user' => $this->kim->getId()->toRfc4122()],
        );
    }

    private function stripeHas(string $subscription, string $status, string $organizationId, int $quantity): void
    {
        $this->router()->respond(StripeClient::API.'/subscriptions/'.$subscription, (string) json_encode([
            'id' => $subscription,
            'customer' => 'cus_kim',
            'status' => $status,
            'metadata' => ['organization_id' => $organizationId],
            'items' => ['data' => [['quantity' => $quantity, 'current_period_end' => 1796083200]]],
        ]));
    }

    /** @param array<string, mixed> $object */
    private function webhook(string $id, string $type, array $object): void
    {
        $body = (string) json_encode(['id' => $id, 'type' => $type, 'data' => ['object' => $object]]);
        $time = time();

        $this->client->request('POST', '/billing/stripe/webhook', server: [
            'HTTP_STRIPE_SIGNATURE' => 't='.$time.',v1='.hash_hmac('sha256', $time.'.'.$body, self::WEBHOOK_SECRET),
            'CONTENT_TYPE' => 'application/json',
        ], content: $body);
    }

    private function router(): MockHttpRouter
    {
        return static::getContainer()->get(MockHttpRouter::class);
    }
}
