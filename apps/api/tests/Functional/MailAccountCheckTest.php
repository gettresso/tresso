<?php

declare(strict_types=1);

namespace App\Tests\Functional;

use Symfony\Component\Process\Process;

/**
 * Checking an IMAP/SMTP account before it is created, against a scripted mail server on this machine (the test
 * environment allows local servers: MAIL_ALLOW_UNSAFE_SERVERS=1). The address rules are tested in
 * MailServerDialerTest, the protocols in ImapCheckTest and SmtpCheckTest.
 */
final class MailAccountCheckTest extends DatabaseTestCase
{
    use AuthenticatesUsers;

    /** @var array<string, string> */
    private array $kim;

    private ?Process $server = null;

    protected function setUp(): void
    {
        parent::setUp();
        $this->bootstrapOAuthClients();
        $this->createUser('kim@example.test', 'Kim Visser');
        $this->kim = $this->userHeaders('kim@example.test', ['settings:read', 'settings:write']);
    }

    protected function tearDown(): void
    {
        $this->server?->stop(0);
        parent::tearDown();
    }

    public function testAWorkingAccountPassesAndNothingIsCreated(): void
    {
        $check = $this->check($this->servers('right', 'right'), 'right');

        self::assertSame(['emailAddress' => 'kim@studio-noord.example', 'imap' => 'ok', 'smtp' => 'ok', 'folders' => 3, 'detail' => null], $check);
        self::assertSame(0, $this->countRows('SELECT COUNT(*) FROM mail_account'));
    }

    public function testARefusedPasswordLeavesOutgoingMailUnchecked(): void
    {
        $check = $this->check($this->servers('right', 'right'), 'wrong');

        self::assertSame('auth_failed', $check['imap']);
        self::assertSame('not_checked', $check['smtp']);
        self::assertNull($check['folders']);
        self::assertSame('The server said: [AUTHENTICATIONFAILED] Invalid credentials', $check['detail']);
    }

    public function testOutgoingMailIsCheckedToo(): void
    {
        $check = $this->check($this->servers('right', 'only-for-smtp'), 'right');

        self::assertSame('ok', $check['imap']);
        self::assertSame('auth_failed', $check['smtp']);
        self::assertSame('The server said: 535 5.7.8 Authentication credentials invalid', $check['detail']);
    }

    public function testAServerThatIsNotThereIsUnreachable(): void
    {
        $listener = stream_socket_server('tcp://127.0.0.1:0');
        self::assertIsResource($listener);
        $port = (int) substr((string) strrchr((string) stream_socket_get_name($listener, false), ':'), 1);
        fclose($listener);

        $check = $this->check([$port, $port], 'right');

        self::assertSame('unreachable', $check['imap']);
        self::assertSame('not_checked', $check['smtp']);
        self::assertStringEndsWith('(127.0.0.1:'.$port.').', (string) $check['detail']);
    }

    public function testAnAddressThatIsConnectedAlreadyIsSaidAtOnce(): void
    {
        $this->client->jsonRequest('POST', '/api/v1/mail-accounts', ['displayName' => 'Kim'] + $this->payload([993, 465], 'right'), $this->kim);
        self::assertResponseStatusCodeSame(201);

        $this->client->jsonRequest('POST', '/api/v1/mail-account-checks', $this->payload([993, 465], 'right'), $this->kim);

        self::assertResponseStatusCodeSame(422);
        self::assertStringContainsString('"propertyPath":"emailAddress"', (string) $this->client->getResponse()->getContent());
    }

    public function testInputIsValidatedLikeANewAccount(): void
    {
        $payload = $this->payload([993, 465], '');
        $payload['imap'] = ['host' => '', 'port' => 99999, 'security' => 'tls'];

        $this->client->jsonRequest('POST', '/api/v1/mail-account-checks', $payload, $this->kim);

        self::assertResponseStatusCodeSame(422);
        $content = (string) $this->client->getResponse()->getContent();
        foreach (['password', 'imap.host', 'imap.port'] as $path) {
            self::assertStringContainsString('"propertyPath":"'.$path.'"', $content);
        }
    }

    public function testNeedsSettingsWrite(): void
    {
        $this->client->jsonRequest('POST', '/api/v1/mail-account-checks', $this->payload([993, 465], 'right'), $this->userHeaders('kim@example.test', ['settings:read']));

        self::assertResponseStatusCodeSame(403);
    }

    /**
     * Starts the scripted server and returns its IMAP and SMTP ports.
     *
     * @return array{int, int}
     */
    private function servers(string $imapPassword, string $smtpPassword): array
    {
        $this->server = new Process([\PHP_BINARY, __DIR__.'/../Support/bin/scripted-mail-server.php', $imapPassword, $smtpPassword]);
        $this->server->start();
        $ports = null;
        $this->server->waitUntil(static function (string $type, string $output) use (&$ports): bool {
            $ports = array_map('intval', explode(' ', trim($output)));

            return Process::OUT === $type && 2 === \count($ports) && $ports[0] > 0;
        });
        self::assertIsArray($ports);

        return [$ports[0], $ports[1] ?? 0];
    }

    /**
     * @param array{int, int} $ports
     *
     * @return array<string, mixed>
     */
    private function check(array $ports, string $password): array
    {
        $this->client->jsonRequest('POST', '/api/v1/mail-account-checks', $this->payload($ports, $password), $this->kim);
        self::assertResponseStatusCodeSame(200);

        return $this->decodedResponse();
    }

    /**
     * @param array{int, int} $ports
     *
     * @return array<string, mixed>
     */
    private function payload(array $ports, string $password): array
    {
        return [
            'emailAddress' => 'kim@studio-noord.example',
            'username' => 'kim@studio-noord.example',
            'password' => $password,
            'imap' => ['host' => '127.0.0.1', 'port' => $ports[0], 'security' => 'none'],
            'smtp' => ['host' => '127.0.0.1', 'port' => $ports[1], 'security' => 'none'],
        ];
    }
}
