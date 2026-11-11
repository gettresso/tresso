<?php

declare(strict_types=1);

namespace App\Mail\Autoconfig;

/**
 * A large mail provider an address belongs to, which decides the easiest way to connect it: Google, Outlook.com and
 * Microsoft 365 through their own sign-in page, iCloud and Yahoo with an app password.
 */
enum MailServiceProvider: string
{
    case Google = 'google';
    /** Outlook.com, Hotmail, Live and MSN: personal Microsoft accounts. */
    case Outlook = 'outlook';
    /** Work and school accounts on Microsoft 365. */
    case Microsoft365 = 'm365';
    case ICloud = 'icloud';
    case Yahoo = 'yahoo';

    private const array DOMAINS = [
        'gmail.com' => self::Google,
        'googlemail.com' => self::Google,
        'outlook.com' => self::Outlook,
        'hotmail.com' => self::Outlook,
        'live.com' => self::Outlook,
        'msn.com' => self::Outlook,
        'icloud.com' => self::ICloud,
        'me.com' => self::ICloud,
        'mac.com' => self::ICloud,
        'ymail.com' => self::Yahoo,
    ];

    /** Suffixes of mail exchanger host names, checked in this order. */
    private const array EXCHANGERS = [
        'google.com' => self::Google,
        'googlemail.com' => self::Google,
        'mail.protection.outlook.com' => self::Microsoft365,
        'olc.protection.outlook.com' => self::Outlook,
        'yahoodns.net' => self::Yahoo,
        'icloud.com' => self::ICloud,
    ];

    public static function forDomain(string $domain): ?self
    {
        $domain = strtolower(rtrim($domain, '.'));
        if (isset(self::DOMAINS[$domain])) {
            return self::DOMAINS[$domain];
        }

        // yahoo.com, yahoo.co.uk, yahoo.com.au, yahoo.de and the other country domains; not yahoo.mycompany.example.
        return 1 === preg_match('/^yahoo\.(com|[a-z]{2}|co\.[a-z]{2}|com\.[a-z]{2})$/', $domain) ? self::Yahoo : null;
    }

    public static function forMailExchanger(string $host): ?self
    {
        $host = strtolower(rtrim($host, '.'));
        foreach (self::EXCHANGERS as $suffix => $provider) {
            if ($host === $suffix || str_ends_with($host, '.'.$suffix)) {
                return $provider;
            }
        }

        return null;
    }
}
