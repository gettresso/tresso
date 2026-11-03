<?php

declare(strict_types=1);

namespace App\Tests\Functional\Mcp;

use App\Entity\SenderRule;
use App\Entity\User;
use App\Repository\CategoryRepository;
use App\Tests\Functional\AuthenticatesUsers;
use App\Tests\Functional\ConnectsThirdPartyApps;
use App\Tests\Functional\DatabaseTestCase;
use Doctrine\ORM\EntityManagerInterface;

/**
 * Every settings tool does through MCP what its API operation does, and the change is in the database afterwards.
 * Kim connects as an app she allowed, with the scopes the tools need.
 */
final class McpSettingsToolsTest extends DatabaseTestCase
{
    use AuthenticatesUsers;
    use ConnectsThirdPartyApps;
    use TalksMcp;

    private const array SETTINGS_SCOPES = ['settings:read', 'settings:write', 'signatures:read', 'signatures:write', 'calendar:read', 'calendar:write', 'mail:read'];

    private User $kim;

    /** @var array<string, string> */
    private array $headers;

    private string $session;

    protected function setUp(): void
    {
        parent::setUp();
        $this->bootstrapOAuthClients();
        $this->kim = $this->createUser('kim@example.test', 'Kim Visser');
        $this->createUser('lisa@example.test', 'Lisa Bakker');
        $this->headers = $this->thirdPartyHeaders('kim@example.test', self::SETTINGS_SCOPES);
        $this->session = $this->mcpInitialize($this->headers);
    }

    public function testGetMeTellsWhoAndWhatTheConnectionMayDo(): void
    {
        $account = $this->createAccount('kim@company.example');

        $me = $this->call('get_me');

        self::assertSame('kim@example.test', $me['email'] ?? null);
        self::assertEqualsCanonicalizing(self::SETTINGS_SCOPES, $me['scopes'] ?? null);
        $accounts = self::asList($me['mailAccounts'] ?? null);
        self::assertSame([$account], array_column($accounts, 'id'));
        self::assertArrayNotHasKey('username', $accounts[0], 'How an account connects is left out.');
        self::assertArrayNotHasKey('imap', $accounts[0]);

        self::assertSame('tresso-server', $this->call('get_server_info')['product'] ?? null);
    }

    public function testSignatureIsMadeAndBecomesTheDefaultOfAnAccount(): void
    {
        $account = $this->createAccount('kim@company.example');

        $signature = $this->call('create_signature', ['name' => 'Work', 'html' => '<p onclick="x()">Kim Visser</p>']);
        $id = $signature['id'] ?? null;
        self::assertIsString($id);
        self::assertSame('<p>Kim Visser</p>', $signature['html'] ?? null, 'The API cleans the HTML, as for every client.');
        self::assertSame('Work', $this->connection()->fetchOne('SELECT name FROM signature WHERE id = ?', [$id]));

        $set = $this->call('set_default_signature', ['mailAccountId' => $account, 'signatureId' => $id]);
        self::assertSame($id, $set['defaultSignatureId'] ?? null);
        self::assertSame($id, $this->defaultSignatureOf($account));

        $other = $this->call('create_signature', ['name' => 'Short', 'html' => '<p>K.</p>'])['id'] ?? null;
        self::assertIsString($other);
        $this->call('set_default_signature', ['mailAccountId' => $account, 'signatureId' => $other]);
        self::assertSame($other, $this->defaultSignatureOf($account), 'An account has one default; the new one replaces it.');
        self::assertSame([], $this->call('get_signature', ['id' => $id])['defaultFor'] ?? null);

        $cleared = $this->call('set_default_signature', ['mailAccountId' => $account, 'signatureId' => null]);
        self::assertTrue($cleared['changed'] ?? null);
        self::assertNull($this->defaultSignatureOf($account));

        $this->call('update_signature', ['id' => $id, 'name' => 'Office', 'defaultFor' => [$account]]);
        self::assertSame('Office', $this->connection()->fetchOne('SELECT name FROM signature WHERE id = ?', [$id]));
        self::assertSame($id, $this->defaultSignatureOf($account));
        self::assertSame(['Office', 'Short'], array_column(self::asList($this->call('list_signatures')), 'name'));

        self::assertSame(['deleted' => $id], $this->call('delete_signature', ['id' => $id]));
        self::assertSame(0, $this->countRows('SELECT COUNT(*) FROM signature WHERE id = :value', ['value' => $id]));
        self::assertNull($this->defaultSignatureOf($account));
    }

    public function testMailAccountIsRenamedAndPaused(): void
    {
        $account = $this->createAccount('kim@company.example');

        $updated = $this->call('update_mail_account', ['id' => $account, 'displayName' => 'Kim at work', 'status' => 'paused']);

        self::assertSame('paused', $updated['status'] ?? null);
        self::assertSame(['Kim at work', 'paused'], array_values((array) $this->connection()->fetchAssociative('SELECT display_name, status FROM mail_account WHERE id = ?', [$account])));
        self::assertSame('Kim at work', $this->call('get_mail_account', ['id' => $account])['displayName'] ?? null);
        self::assertSame([$account], array_column(self::asList($this->call('list_mail_accounts')), 'id'));

        $this->call('update_mail_account', ['id' => $account, 'status' => 'active']);
        self::assertSame('active', $this->connection()->fetchOne('SELECT status FROM mail_account WHERE id = ?', [$account]));
    }

    public function testSmartInboxIsMadeAndGetsItsSenders(): void
    {
        $created = $this->call('create_smart_inbox', ['name' => 'Suppliers', 'verdict' => 'know', 'includeSenders' => ['@supplier.example']]);
        $id = $created['id'] ?? null;
        self::assertIsString($id);

        $this->call('add_smart_inbox_senders', ['id' => $id, 'senders' => ['Anna@Partner.example', '@supplier.example']]);
        self::assertSame(['@supplier.example', 'anna@partner.example'], $this->senders($id, 'include_senders'));

        $this->call('add_smart_inbox_senders', ['id' => $id, 'senders' => ['anna@partner.example'], 'list' => 'exclude']);
        self::assertSame(['@supplier.example'], $this->senders($id, 'include_senders'), 'A sender moves to the other list.');
        self::assertSame(['anna@partner.example'], $this->senders($id, 'exclude_senders'));

        $this->call('remove_smart_inbox_senders', ['id' => $id, 'senders' => ['anna@partner.example']]);
        self::assertSame([], $this->senders($id, 'exclude_senders'));

        $updated = $this->call('update_smart_inbox', ['id' => $id, 'name' => 'Vendors', 'verdict' => 'do', 'autoCreateTodo' => true, 'batchDelivery' => true]);
        self::assertTrue($updated['autoCreateTodo'] ?? null);
        self::assertSame(['Vendors', 'do', true, true], array_values((array) $this->connection()->fetchAssociative('SELECT name, verdict, auto_create_todo, batch_delivery FROM category WHERE id = ?', [$id])));
        self::assertSame('Vendors', $this->call('get_smart_inbox', ['id' => $id])['name'] ?? null);
        self::assertContains('Vendors', array_column(self::asList($this->call('list_smart_inboxes')), 'name'));
        self::assertSame(0, $this->call('get_smart_inbox_senders', ['id' => $id])['conversations'] ?? null);

        $this->call('delete_smart_inbox', ['id' => $id]);
        self::assertSame(0, $this->countRows('SELECT COUNT(*) FROM category WHERE id = :value', ['value' => $id]));
    }

    public function testAValidationErrorComesBackAsAToolError(): void
    {
        $error = $this->mcpCallError($this->headers, $this->session, 'create_smart_inbox', ['name' => 'Reading', 'verdict' => 'know', 'autoCreateTodo' => true]);

        self::assertStringContainsString('Some values were not accepted:', $error);
        self::assertStringContainsString('autoCreateTodo: Only smart inboxes with the Do verdict can create todos.', $error);
        self::assertSame(0, $this->countRows('SELECT COUNT(*) FROM category WHERE name = :value', ['value' => 'Reading']));

        $builtin = $this->connection()->fetchOne('SELECT id FROM category WHERE owner_id = ? AND builtin IS NOT NULL LIMIT 1', [$this->kim->getId()->toRfc4122()]);
        self::assertIsString($builtin);
        self::assertStringContainsString('Built-in smart inboxes cannot be deleted.', $this->mcpCallError($this->headers, $this->session, 'delete_smart_inbox', ['id' => $builtin]));
    }

    public function testSenderRulesAreListedAndForgotten(): void
    {
        $entityManager = static::getContainer()->get(EntityManagerInterface::class);
        $kim = $entityManager->find(User::class, $this->kim->getId());
        self::assertInstanceOf(User::class, $kim);
        $category = static::getContainer()->get(CategoryRepository::class)->findOwnedBy($kim)[0];
        $rule = new SenderRule($kim, 'anna@partner.example', $category, null);
        $entityManager->persist($rule);
        $entityManager->flush();
        $id = $rule->getId()->toRfc4122();

        self::assertSame(['anna@partner.example'], array_column(self::asList($this->call('list_sender_rules')), 'sender'));

        $this->call('delete_sender_rule', ['id' => $id]);
        self::assertSame(0, $this->countRows('SELECT COUNT(*) FROM sender_rule WHERE id = :value', ['value' => $id]));
    }

    public function testNotificationSettingsChange(): void
    {
        $updated = $this->call('update_notification_settings', [
            'quietHoursEnabled' => true,
            'quietStart' => '21:30',
            'workDays' => [1, 2, 3, 4],
            'channelsByKind' => ['mail' => ['email'], 'leave_now' => ['phone', 'desktop']],
        ]);

        self::assertSame('21:30', $updated['quietStart'] ?? null);
        $row = $this->connection()->fetchAssociative('SELECT quiet_hours_enabled, quiet_start, work_days, channels_by_kind FROM notification_preferences WHERE user_id = ?', [$this->kim->getId()->toRfc4122()]);
        self::assertIsArray($row);
        self::assertTrue($row['quiet_hours_enabled']);
        self::assertSame('21:30', $row['quiet_start']);
        self::assertSame([1, 2, 3, 4], json_decode(self::asString($row['work_days']), true));
        self::assertSame(['email'], self::asArray(json_decode(self::asString($row['channels_by_kind']), true))['mail'] ?? null);
        self::assertSame(['email'], self::asArray($this->call('get_notification_settings')['channelsByKind'] ?? null)['mail'] ?? null);

        $error = $this->mcpCallError($this->headers, $this->session, 'update_notification_settings', ['timeZone' => 'Mars/Olympus']);
        self::assertStringContainsString('timeZone', $error);
    }

    public function testNotificationDevicesAreRenamedSwitchedAndRemoved(): void
    {
        $web = $this->userHeaders('kim@example.test', ['settings:write']);
        $this->client->jsonRequest('POST', '/api/v1/notification-devices', ['kind' => 'expo', 'endpoint' => 'ExponentPushToken[kim-phone]', 'name' => 'Phone'], $web);
        self::assertResponseIsSuccessful();
        $device = $this->responseString('id');

        self::assertSame([$device], array_column(self::asList($this->call('list_notification_devices')), 'id'));

        $this->call('update_notification_device', ['id' => $device, 'name' => 'Kim\'s phone', 'enabled' => false]);
        self::assertSame(['Kim\'s phone', false], array_values((array) $this->connection()->fetchAssociative('SELECT name, enabled FROM notification_device WHERE id = ?', [$device])));

        $this->call('delete_notification_device', ['id' => $device]);
        self::assertSame(0, $this->countRows('SELECT COUNT(*) FROM notification_device WHERE id = :value', ['value' => $device]));
    }

    public function testBatchTimesAndTheDailyBriefChangeOnlyWhatIsGiven(): void
    {
        $this->call('update_batch_delivery', ['times' => ['08:00', '13:00'], 'timeZone' => 'Europe/Amsterdam']);
        $this->call('update_batch_delivery', ['times' => ['07:30']]);

        $batch = $this->call('get_batch_delivery');
        self::assertSame(['07:30'], $batch['times'] ?? null);
        self::assertSame('Europe/Amsterdam', $batch['timeZone'] ?? null, 'The time zone left out stays.');
        self::assertSame('Europe/Amsterdam', $this->connection()->fetchOne('SELECT time_zone FROM batch_schedule WHERE user_id = ?', [$this->kim->getId()->toRfc4122()]));

        $this->call('update_daily_brief_settings', ['enabled' => true, 'deliverAt' => '07:15', 'channels' => ['email']]);
        $this->call('update_daily_brief_settings', ['deliverAt' => '06:45']);

        $brief = $this->call('get_daily_brief_settings');
        self::assertTrue($brief['enabled'] ?? null);
        self::assertSame(['email'], $brief['channels'] ?? null);
        self::assertSame([true, '06:45'], array_values((array) $this->connection()->fetchAssociative('SELECT enabled, deliver_at FROM daily_brief_settings WHERE user_id = ?', [$this->kim->getId()->toRfc4122()])));
    }

    public function testCalendarsSchedulingAndReminderRules(): void
    {
        $calendar = $this->call('create_calendar', ['name' => 'Sport', 'color' => '#2F80ED'])['id'] ?? null;
        self::assertIsString($calendar);
        $this->call('update_calendar', ['id' => $calendar, 'color' => '#27AE60', 'work' => true]);
        self::assertSame(['#27ae60', true], array_values((array) $this->connection()->fetchAssociative('SELECT color, work FROM calendar WHERE id = ?', [$calendar])));
        self::assertContains($calendar, array_column(self::asList($this->call('list_calendars')), 'id'));
        self::assertSame('Sport', $this->call('get_calendar', ['id' => $calendar])['name'] ?? null);

        $this->call('update_scheduling_preferences', ['bufferMinutes' => 15, 'planTodos' => true]);
        self::assertSame(15, $this->call('get_scheduling_preferences')['bufferMinutes'] ?? null);
        self::assertSame([15, true], array_values((array) $this->connection()->fetchAssociative('SELECT buffer_minutes, plan_todos FROM scheduling_preferences WHERE user_id = ?', [$this->kim->getId()->toRfc4122()])));

        $rule = $this->call('create_reminder_rule', [
            'name' => 'Sport',
            'calendarId' => $calendar,
            'reminders' => [['minutesBefore' => 30, 'channels' => ['phone']]],
            'leaveNow' => true,
        ]);
        $ruleId = $rule['id'] ?? null;
        self::assertIsString($ruleId);

        $this->call('update_reminder_rule', ['id' => $ruleId, 'name' => 'Training']);
        $stored = $this->call('get_reminder_rule', ['id' => $ruleId]);
        self::assertSame('Training', $stored['name'] ?? null);
        self::assertSame($calendar, $stored['calendarId'] ?? null, 'What the update left out stays.');
        self::assertTrue($stored['leaveNow'] ?? null);
        self::assertSame(30, self::asList($stored['reminders'] ?? null)[0]['minutesBefore'] ?? null);
        self::assertSame('Training', $this->connection()->fetchOne('SELECT name FROM reminder_rule WHERE id = ?', [$ruleId]));
        self::assertContains($ruleId, array_column(self::asList($this->call('list_reminder_rules')), 'id'));

        $this->call('delete_reminder_rule', ['id' => $ruleId]);
        self::assertSame(0, $this->countRows('SELECT COUNT(*) FROM reminder_rule WHERE id = :value', ['value' => $ruleId]));

        $this->call('delete_calendar', ['id' => $calendar]);
        self::assertSame(0, $this->countRows('SELECT COUNT(*) FROM calendar WHERE id = :value', ['value' => $calendar]));
    }

    public function testAnotherUsersSettingsAreOutOfReach(): void
    {
        $signature = $this->call('create_signature', ['name' => 'Work', 'html' => '<p>Kim</p>'])['id'] ?? null;
        $smartInbox = $this->call('create_smart_inbox', ['name' => 'Suppliers', 'verdict' => 'know'])['id'] ?? null;
        self::assertIsString($signature);
        self::assertIsString($smartInbox);

        $lisa = $this->thirdPartyHeaders('lisa@example.test', self::SETTINGS_SCOPES);
        $session = $this->mcpInitialize($lisa);

        foreach ([
            ['get_signature', ['id' => $signature]],
            ['update_signature', ['id' => $signature, 'name' => 'Mine now']],
            ['delete_signature', ['id' => $signature]],
            ['add_smart_inbox_senders', ['id' => $smartInbox, 'senders' => ['@lisa.example']]],
            ['delete_smart_inbox', ['id' => $smartInbox]],
        ] as [$tool, $arguments]) {
            self::assertStringStartsWith('Not found', $this->mcpCallError($lisa, $session, $tool, $arguments), $tool);
        }

        self::assertSame('Work', $this->connection()->fetchOne('SELECT name FROM signature WHERE id = ?', [$signature]));
        self::assertSame([], $this->senders($smartInbox, 'include_senders'));
        self::assertSame([], self::asList($this->mcpCallOk($lisa, $session, 'list_signatures')));
    }

    /**
     * @param array<string, mixed> $arguments
     *
     * @return array<mixed>
     */
    private function call(string $tool, array $arguments = []): array
    {
        return $this->mcpCallOk($this->headers, $this->session, $tool, $arguments);
    }

    private function createAccount(string $emailAddress): string
    {
        $this->client->jsonRequest('POST', '/api/v1/mail-accounts', [
            'emailAddress' => $emailAddress,
            'displayName' => $emailAddress,
            'username' => $emailAddress,
            'password' => 'app-password-1',
            'imap' => ['host' => 'imap.company.example', 'port' => 993, 'security' => 'tls'],
            'smtp' => ['host' => 'smtp.company.example', 'port' => 465, 'security' => 'tls'],
        ], $this->userHeaders('kim@example.test', ['settings:write']));
        self::assertResponseStatusCodeSame(201);

        return $this->responseString('id');
    }

    private function defaultSignatureOf(string $account): mixed
    {
        return $this->connection()->fetchOne('SELECT default_signature_id FROM mail_account WHERE id = ?', [$account]);
    }

    /**
     * @return list<string>
     */
    private function senders(string $smartInbox, string $column): array
    {
        $senders = self::asArray(json_decode(self::asString($this->connection()->fetchOne(\sprintf('SELECT %s FROM category WHERE id = ?', $column), [$smartInbox])), true));

        return array_map(self::asString(...), array_values($senders));
    }
}
