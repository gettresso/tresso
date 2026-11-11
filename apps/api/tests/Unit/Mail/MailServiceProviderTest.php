<?php

declare(strict_types=1);

namespace App\Tests\Unit\Mail;

use App\Mail\Autoconfig\MailServiceProvider;
use PHPUnit\Framework\Attributes\DataProvider;
use PHPUnit\Framework\TestCase;

final class MailServiceProviderTest extends TestCase
{
    /**
     * @return iterable<string, array{string, MailServiceProvider|null}>
     */
    public static function domains(): iterable
    {
        yield 'gmail' => ['gmail.com', MailServiceProvider::Google];
        yield 'googlemail' => ['GoogleMail.com', MailServiceProvider::Google];
        yield 'outlook' => ['outlook.com', MailServiceProvider::Outlook];
        yield 'hotmail' => ['hotmail.com', MailServiceProvider::Outlook];
        yield 'live' => ['live.com', MailServiceProvider::Outlook];
        yield 'msn' => ['msn.com', MailServiceProvider::Outlook];
        yield 'icloud' => ['icloud.com', MailServiceProvider::ICloud];
        yield 'me' => ['me.com', MailServiceProvider::ICloud];
        yield 'mac' => ['mac.com', MailServiceProvider::ICloud];
        yield 'yahoo' => ['yahoo.com', MailServiceProvider::Yahoo];
        yield 'yahoo abroad' => ['yahoo.co.jp', MailServiceProvider::Yahoo];
        yield 'ymail' => ['ymail.com', MailServiceProvider::Yahoo];
        yield 'a domain ending in yahoo' => ['notyahoo.com', null];
        yield 'yahoo australia' => ['yahoo.com.au', MailServiceProvider::Yahoo];
        yield 'a company domain under yahoo.' => ['yahoo.mycompany.example', null];
        yield 'company' => ['studio-noord.example', null];
    }

    #[DataProvider('domains')]
    public function testKnowsTheLargeProvidersByDomain(string $domain, ?MailServiceProvider $expected): void
    {
        self::assertSame($expected, MailServiceProvider::forDomain($domain));
    }

    /**
     * @return iterable<string, array{string, MailServiceProvider|null}>
     */
    public static function exchangers(): iterable
    {
        yield 'google workspace' => ['aspmx.l.google.com', MailServiceProvider::Google];
        yield 'google with dot' => ['alt1.aspmx.l.google.com.', MailServiceProvider::Google];
        yield 'googlemail' => ['gmail-smtp-in.l.googlemail.com', MailServiceProvider::Google];
        yield 'microsoft 365' => ['company-example.mail.protection.outlook.com', MailServiceProvider::Microsoft365];
        yield 'outlook.com' => ['company-example.olc.protection.outlook.com', MailServiceProvider::Outlook];
        yield 'yahoo' => ['mta6.am0.yahoodns.net', MailServiceProvider::Yahoo];
        yield 'icloud' => ['mx02.mail.icloud.com', MailServiceProvider::ICloud];
        yield 'look-alike' => ['mx.notgoogle.com', null];
        yield 'own server' => ['mail.studio-noord.example', null];
    }

    #[DataProvider('exchangers')]
    public function testKnowsHostedMailByTheMailExchanger(string $host, ?MailServiceProvider $expected): void
    {
        self::assertSame($expected, MailServiceProvider::forMailExchanger($host));
    }
}
