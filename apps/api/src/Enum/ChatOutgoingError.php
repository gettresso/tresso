<?php

declare(strict_types=1);

namespace App\Enum;

/** Why a reply failed. */
enum ChatOutgoingError: string
{
    /** The bridge on the relaying desktop was not running. */
    case BridgeStopped = 'bridge_stopped';
    /** The bridge was not linked to the phone. */
    case NotLinked = 'not_linked';
    /** The bridge or WhatsApp refused it. */
    case Refused = 'refused';
    /** It stayed in sending too long to know whether it went out; it is never sent again without the user. */
    case Unconfirmed = 'unconfirmed';
    /**
     * The relaying desktop could not fetch the file the reply carries from the server, so nothing went out. Like every
     * failure, it waits for the user's Try again.
     */
    case FileUnavailable = 'file_unavailable';
}
