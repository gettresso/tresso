<?php

declare(strict_types=1);

namespace App\Tests\Functional\Mcp;

use App\Billing\PaymentWall;
use App\Entity\User;
use App\Tests\Functional\AuthenticatesUsers;
use App\Tests\Functional\ConnectsThirdPartyApps;
use App\Tests\Functional\DatabaseTestCase;

/**
 * On a server that bills (TRESSO_BILLING=1, as Tresso Cloud), a user past the trial without a subscription is blocked
 * in MCP tools exactly where the REST API blocks them (App\Billing\PaymentWall): a tool error with the 402 message,
 * and nothing changes. What REST leaves open stays open.
 */
final class McpBillingTest extends DatabaseTestCase
{
    use AuthenticatesUsers;
    use ConnectsThirdPartyApps;
    use TalksMcp;

    private const array SETTINGS = ['TRESSO_BILLING' => '1', 'STRIPE_SECRET_KEY' => 'sk_test_mcp', 'STRIPE_PRICE_MONTHLY' => 'price_monthly'];

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

    public function testToolsWorkDuringTheTrial(): void
    {
        $headers = $this->personalAccessTokenHeaders('kim@example.test', ['settings:read', 'settings:write']);
        $session = $this->mcpInitialize($headers);

        $this->mcpCallOk($headers, $session, 'create_smart_inbox', ['name' => 'Suppliers', 'verdict' => 'know']);

        self::assertSame(1, $this->countRows('SELECT COUNT(*) FROM category WHERE name = :name', ['name' => 'Suppliers']));
    }

    public function testAfterTheTrialToolsAreBlockedWhereTheApiIs(): void
    {
        foreach ([
            'personal access token' => $this->personalAccessTokenHeaders('kim@example.test', ['settings:read', 'settings:write']),
            'third-party app' => $this->thirdPartyHeaders('kim@example.test', ['settings:read', 'settings:write']),
        ] as $caller => $headers) {
            $this->endTrial();
            $session = $this->mcpInitialize($headers);

            $this->client->request('GET', '/api/v1/smart-inboxes', server: $headers);
            self::assertResponseStatusCodeSame(402, 'REST is blocked.');

            foreach ([
                ['create_smart_inbox', ['name' => 'Suppliers', 'verdict' => 'know']],
                ['list_smart_inboxes', []],
                ['update_notification_settings', ['quietHoursEnabled' => true]],
                ['get_me', []],
            ] as [$tool, $arguments]) {
                $error = $this->mcpCallError($headers, $session, $tool, $arguments);
                self::assertSame('Payment required: '.PaymentWall::DETAIL, $error, \sprintf('%s for a %s', $tool, $caller));
            }

            self::assertSame('tresso-server', $this->mcpCallOk($headers, $session, 'get_server_info')['product'] ?? null, 'What REST leaves open stays open.');
        }

        self::assertSame(0, $this->countRows('SELECT COUNT(*) FROM category WHERE name = :name', ['name' => 'Suppliers']));
        self::assertSame(0, $this->countRows('SELECT COUNT(*) FROM notification_preferences WHERE user_id = :user AND quiet_hours_enabled', ['user' => $this->kim->getId()->toRfc4122()]));
    }

    private function endTrial(): void
    {
        $this->connection()->executeStatement(
            "UPDATE billing_subscription SET trial_ends_at = NOW() - INTERVAL '1 day' WHERE organization_id = (SELECT id FROM organization WHERE personal_owner_id = :user)",
            ['user' => $this->kim->getId()->toRfc4122()],
        );
    }
}
