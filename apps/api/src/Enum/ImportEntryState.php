<?php

declare(strict_types=1);

namespace App\Enum;

/**
 * Where one address of a mail account import list stands. `connected` is never stored: it is read from the owner's
 * mail accounts whenever the list is read, so an account connected any other way counts too.
 */
enum ImportEntryState: string
{
    /** Not connected, not skipped, and no failed sign-in since the user last tried. */
    case Todo = 'todo';
    /** The owner has a mail account with this address. */
    case Connected = 'connected';
    /** The last sign-in for this address failed; `failure` says why. */
    case Failed = 'failed';
    /** The user chose not to add this address. */
    case Skipped = 'skipped';
}
