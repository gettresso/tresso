<?php

declare(strict_types=1);

namespace App\Tests\Unit\Mail\Check;

use App\Mail\Check\CheckFailed;
use App\Mail\Check\CheckStatus;
use App\Mail\Check\ImapCheck;
use PHPUnit\Framework\TestCase;

final class ImapCheckTest extends TestCase
{
    public function testSignsInAndCountsTheFolders(): void
    {
        $connection = new ScriptedConnection([
            '* OK [CAPABILITY IMAP4rev1] ready',
            't1 OK LOGIN completed',
            '* LIST (\HasNoChildren) "/" INBOX',
            '* LIST (\HasNoChildren \Sent) "/" Sent',
            't2 OK LIST completed',
        ]);

        self::assertSame(2, new ImapCheck($connection, 'imap.example.test')->run(false, 'kim@example.test', 'pass"word\\'));
        self::assertSame(["t1 LOGIN \"kim@example.test\" \"pass\\\"word\\\\\"\r\n", "t2 LIST \"\" \"*\"\r\n", "t3 LOGOUT\r\n"], $connection->written);
        self::assertFalse($connection->tls);
    }

    public function testUpgradesWithStartTlsBeforeSigningIn(): void
    {
        $connection = new ScriptedConnection(['* OK ready', 't1 OK Begin TLS', 't2 OK LOGIN completed', 't3 OK LIST completed']);

        self::assertSame(0, new ImapCheck($connection, 'imap.example.test')->run(true, 'kim', 'secret'));
        self::assertTrue($connection->tls);
        self::assertSame("t1 STARTTLS\r\n", $connection->written[0]);
    }

    public function testSendsCredentialsWithLineBreaksOrAccentsAsLiterals(): void
    {
        $connection = new ScriptedConnection(['* OK ready', '+ go ahead', 't1 OK LOGIN completed', 't2 OK LIST completed']);

        new ImapCheck($connection, 'imap.example.test')->run(false, 'kim', 'wachtwoörd');

        self::assertSame(["t1 LOGIN \"kim\" {11}\r\n", "wachtwoörd\r\n"], \array_slice($connection->written, 0, 2));
    }

    public function testARefusedSignInIsAnAuthenticationFailureWithTheServersWords(): void
    {
        $connection = new ScriptedConnection(['* OK ready', 't1 NO [AUTHENTICATIONFAILED] Invalid credentials']);

        $failure = $this->failure(static fn () => new ImapCheck($connection, 'imap.example.test')->run(false, 'kim', 'wrong'));

        self::assertSame(CheckStatus::AuthFailed, $failure->status);
        self::assertSame('The server said: [AUTHENTICATIONFAILED] Invalid credentials', $failure->getMessage());
    }

    public function testSomethingThatIsNoImapServerFails(): void
    {
        $failure = $this->failure(static fn () => new ImapCheck(new ScriptedConnection(['220 smtp.example.test ESMTP']), 'imap.example.test')->run(false, 'kim', 'secret'));

        self::assertSame(CheckStatus::Failed, $failure->status);
        self::assertStringContainsString('did not greet like an IMAP server', $failure->getMessage());
    }

    public function testAServerThatSaysGoodbyeFails(): void
    {
        $failure = $this->failure(static fn () => new ImapCheck(new ScriptedConnection(['* OK ready', '* BYE Too many connections']), 'imap.example.test')->run(false, 'kim', 'secret'));

        self::assertSame(CheckStatus::Failed, $failure->status);
        self::assertStringContainsString('Too many connections', $failure->getMessage());
    }

    public function testAServerWithoutStartTlsFails(): void
    {
        $connection = new ScriptedConnection(['* OK ready', 't1 BAD STARTTLS not supported']);

        $failure = $this->failure(static fn () => new ImapCheck($connection, 'imap.example.test')->run(true, 'kim', 'secret'));

        self::assertSame(CheckStatus::Failed, $failure->status);
        self::assertSame(["t1 STARTTLS\r\n"], $connection->written, 'The password is never sent without TLS.');
    }

    private function failure(\Closure $run): CheckFailed
    {
        try {
            $run();
        } catch (CheckFailed $e) {
            return $e;
        }
        self::fail('The check passed.');
    }
}
