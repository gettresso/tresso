<?php

declare(strict_types=1);

namespace App\Enum;

/** Whether the bridge is linked to the user's phone, as the relaying desktop last reported it. */
enum ChatLinkState: string
{
    case Linked = 'linked';
    /** The phone has to link the bridge again (a QR code). */
    case Unlinked = 'unlinked';
    /** Not reported yet. */
    case Unknown = 'unknown';
}
