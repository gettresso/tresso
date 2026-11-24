<?php

declare(strict_types=1);

namespace App\Enum;

/**
 * Where one address of a mail account import list stands. Whether the owner has the account is never stored: it is
 * read from the owner's mail accounts whenever the list is read. `connected` is an account added from this list,
 * `already_connected` one added any other way after the list was made.
 */
enum ImportEntryState: string
{
    /** Not connected, not skipped, and no failed sign-in since the user last tried. */
    case Todo = 'todo';
    /** Added from this list: the owner has a mail account with this address. */
    case Connected = 'connected';
    /** The owner has a mail account with this address that was added another way. */
    case AlreadyConnected = 'already_connected';
    /** The last sign-in for this address failed; `failure` says why. */
    case Failed = 'failed';
    /** The user chose not to add this address. */
    case Skipped = 'skipped';
}
