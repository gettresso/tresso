<?php

declare(strict_types=1);

namespace App\Tests\Unit\Mail\Check;

use App\Mail\Check\CheckFailed;
use App\Mail\Check\CheckStatus;
use App\Mail\Check\SmtpCheck;
use PHPUnit\Framework\TestCase;

final class SmtpCheckTest extends TestCase
{
    public function testSignsInWithPlain(): void
    {
        $connection = new ScriptedConnection(['220 smtp.example.test ESMTP', '250-smtp.example.test', '250-SIZE 35882577', '250 AUTH LOGIN PLAIN', '235 2.7.0 Accepted']);

        new SmtpCheck($connection, 'smtp.example.test')->run(false, 'kim', 'secret');

        self::assertSame(["EHLO localhost\r\n", 'AUTH PLAIN '.base64_encode("\0kim\0secret")."\r\n", "QUIT\r\n"], $connection->written);
    }

    public function testSignsInWithLoginWhenThatIsAllThereIs(): void
    {
        $connection = new ScriptedConnection(['220 ready', '250-hello', '250 AUTH=LOGIN', '334 VXNlcm5hbWU6', '334 UGFzc3dvcmQ6', '235 ok']);

        new SmtpCheck($connection, 'smtp.example.test')->run(false, 'kim', 'secret');

        self::assertSame(["AUTH LOGIN\r\n", base64_encode('kim')."\r\n", base64_encode('secret')."\r\n"], \array_slice($connection->written, 1, 3));
    }

    public function testStartsTlsAndSaysHelloAgain(): void
    {
        $connection = new ScriptedConnection(['220 ready', '250-hello', '250 STARTTLS', '220 Go ahead', '250-hello', '250 AUTH PLAIN', '235 ok']);

        new SmtpCheck($connection, 'smtp.example.test')->run(true, 'kim', 'secret');

        self::assertTrue($connection->tls);
        self::assertSame(["EHLO localhost\r\n", "STARTTLS\r\n", "EHLO localhost\r\n"], \array_slice($connection->written, 0, 3));
    }

    public function testAServerThatAsksForNoSignInPasses(): void
    {
        $connection = new ScriptedConnection(['220 ready', '250 hello']);

        new SmtpCheck($connection, 'smtp.example.test')->run(false, 'kim', 'secret');

        self::assertSame(["EHLO localhost\r\n", "QUIT\r\n"], $connection->written);
    }

    public function testARefusedPasswordIsAnAuthenticationFailure(): void
    {
        $connection = new ScriptedConnection(['220 ready', '250-hello', '250 AUTH PLAIN', '535 5.7.8 Authentication credentials invalid']);

        $failure = $this->failure(static fn () => new SmtpCheck($connection, 'smtp.example.test')->run(false, 'kim', 'wrong'));

        self::assertSame(CheckStatus::AuthFailed, $failure->status);
        self::assertSame('The server said: 535 5.7.8 Authentication credentials invalid', $failure->getMessage());
    }

    public function testNoSupportedSignInMethodFails(): void
    {
        $connection = new ScriptedConnection(['220 ready', '250-hello', '250 AUTH CRAM-MD5 XOAUTH2']);

        $failure = $this->failure(static fn () => new SmtpCheck($connection, 'smtp.example.test')->run(false, 'kim', 'secret'));

        self::assertSame(CheckStatus::Failed, $failure->status);
        self::assertSame('The outgoing mail server offers no sign-in method Tresso supports.', $failure->getMessage());
    }

    public function testSomethingThatIsNoSmtpServerFails(): void
    {
        $failure = $this->failure(static fn () => new SmtpCheck(new ScriptedConnection(['* OK IMAP4rev1 ready']), 'smtp.example.test')->run(false, 'kim', 'secret'));

        self::assertSame(CheckStatus::Failed, $failure->status);
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
