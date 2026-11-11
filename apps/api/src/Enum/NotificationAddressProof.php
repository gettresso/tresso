<?php

declare(strict_types=1);

namespace App\Enum;

/**
 * How the user showed that the notification address they chose is theirs, recorded when it was chosen.
 */
enum NotificationAddressProof: string
{
    /** Their own sign-in address. */
    case SignIn = 'sign_in';

    /** The address a Google or Microsoft sign-in confirmed for one of their accounts. */
    case Provider = 'provider';

    /** They opened the confirmation link mailed to it and confirmed. */
    case Link = 'link';
}
