<?php

declare(strict_types=1);

namespace App\Mail\Check;

/**
 * How checking one side of a mail account (IMAP or SMTP) went.
 */
enum CheckStatus: string
{
    case Ok = 'ok';
    /** The server refused the username or password. */
    case AuthFailed = 'auth_failed';
    /** The server could not be found, refused the connection or did not answer in time. */
    case Unreachable = 'unreachable';
    /** The server's TLS certificate could not be verified. */
    case Certificate = 'certificate';
    /** The server resolves to a private or reserved address. */
    case Blocked = 'blocked';
    /** The server answered, but not as a mail server should (or offers no sign-in Tresso supports). */
    case Failed = 'failed';
    /** Not tried, because the other side failed first. */
    case NotChecked = 'not_checked';
}
