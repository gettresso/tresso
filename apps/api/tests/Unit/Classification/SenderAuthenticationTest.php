<?php

declare(strict_types=1);

namespace App\Tests\Unit\Classification;

use App\Classification\ReceivingServers;
use App\Classification\SenderAuthentication;
use App\Enum\MailProvider;
use PHPUnit\Framework\Attributes\DataProvider;
use PHPUnit\Framework\TestCase;

final class SenderAuthenticationTest extends TestCase
{
    /**
     * @return iterable<string, array{string, bool}>
     */
    public static function headers(): iterable
    {
        yield 'Gmail, DMARC passed' => ['mx.google.com; dkim=pass header.i=@finance.example; spf=pass; dmarc=pass (p=REJECT sp=REJECT dis=NONE) header.from=finance.example', true];
        yield 'Microsoft, no authserv-id' => ['spf=pass (sender IP is 1.2.3.4) smtp.mailfrom=finance.example; dkim=pass (signature was verified) header.d=finance.example;dmarc=pass action=none header.from=finance.example;compauth=pass reason=100', true];
        yield 'a version after the authserv-id' => ['mx.google.com 1; dmarc=pass header.from=finance.example', true];
        yield 'DMARC failed' => ['mx.google.com; dmarc=fail (p=NONE) header.from=finance.example', false];
        yield 'a pass in the envelope sender' => ['mx.google.com; spf=pass (google.com: domain of x+dmarc=pass@attacker.example designates 1.2.3.4 as permitted sender) smtp.mailfrom=x+dmarc=pass@attacker.example; dmarc=fail (p=NONE) header.from=finance.example', false];
        yield 'a pass in an ARC comment' => ['mx.google.com; arc=pass (i=1 spf=pass spfdomain=a.example dmarc=pass fromdomain=finance.example); dmarc=fail header.from=finance.example', false];
        yield 'a pass in a quoted string' => ['mx.google.com; spf=pass smtp.mailfrom="a;dmarc=pass"@attacker.example; dmarc=none', false];
        yield 'a pass in a nested comment' => ['mx.google.com; spf=pass (outer (dmarc=pass) still) smtp.mailfrom=a@b.example', false];
        yield 'another result word' => ['mx.google.com; dmarc=passed', false];
        yield 'cut inside a comment' => ['mx.google.com; spf=pass (google.com: domain of "a; dmarc=pass', false];
        yield 'cut inside a quoted string' => ['mx.google.com; spf=pass smtp.mailfrom="a; dmarc=pass ', false];
        yield 'a parenthesis inside a quoted string' => ['mx.google.com; x=y "a ( " ) "; dmarc=pass ;" ; dmarc=fail', false];
        yield 'an escaped parenthesis in a comment' => ['mx.google.com; spf=pass (a \\) ; dmarc=pass) smtp.mailfrom=a@b.example', false];
        yield 'comments three deep' => ['mx.google.com; spf=pass (a (b (c; dmarc=pass) d) e) x; dmarc=fail', false];
        yield 'an escaped quote in a quoted string' => ['mx.google.com; spf=pass smtp.mailfrom="a\\"; dmarc=pass"@b.example; dmarc=none', false];
        yield 'cut after the DMARC result' => ['mx.google.com; dmarc=pass (p=NONE) header.from=a.example; arc=pass (i=1 spf=pass spfdo', true];
    }

    #[DataProvider('headers')]
    public function testOnlyAResultEntryDmarcPassCounts(string $header, bool $passed): void
    {
        self::assertSame($passed, SenderAuthentication::dmarcPassed($header, true));
        self::assertFalse(SenderAuthentication::dmarcPassed($header, false), 'A header the receiving server did not write proves nothing.');
    }

    public function testOnlyGmailsOwnHeaderIsGmails(): void
    {
        self::assertTrue(ReceivingServers::wroteResults(MailProvider::Gmail, 'mx.google.com; dmarc=pass'));
        self::assertFalse(ReceivingServers::wroteResults(MailProvider::Gmail, 'mx.finance.example; dmarc=pass'));
        self::assertFalse(ReceivingServers::wroteResults(MailProvider::Gmail, 'dmarc=pass header.from=finance.example'));
        self::assertFalse(ReceivingServers::wroteResults(MailProvider::Gmail, null));
        self::assertTrue(ReceivingServers::wroteResults(MailProvider::Microsoft, 'spf=pass smtp.mailfrom=finance.example; dmarc=pass'));
        self::assertFalse(ReceivingServers::wroteResults(MailProvider::Imap, 'mx.company.example; dmarc=pass'));
    }
}
