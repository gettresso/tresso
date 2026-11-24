<?php

declare(strict_types=1);

namespace App\Enum;

/**
 * Which way an address of an import list is expected to connect, as the one who made the list says. Only a fallback:
 * the web app looks the address up the way the single "Add account" flow does, and uses the hint when that finds
 * nothing.
 */
enum ImportProviderHint: string
{
    case Google = 'google';
    case Microsoft = 'microsoft';
    case Imap = 'imap';
}
