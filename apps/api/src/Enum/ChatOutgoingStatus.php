<?php

declare(strict_types=1);

namespace App\Enum;

/** Where a reply written in Tresso is on its way out through the relaying desktop. */
enum ChatOutgoingStatus: string
{
    /** Queued; the relaying desktop sends it when it is online. */
    case Waiting = 'waiting';
    /** The relaying desktop claimed it and is handing it to the bridge. */
    case Sending = 'sending';
    /** The bridge accepted it. */
    case Sent = 'sent';
    /** It did not go out; {@see ChatOutgoingError} says why. */
    case Failed = 'failed';
    /** The user took it back before it went out. */
    case Cancelled = 'cancelled';
}
