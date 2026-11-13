<?php

declare(strict_types=1);

namespace App\Enum;

/**
 * Where the file of a chat message is. The file itself stays on the relaying Mac until the user asks for it on another
 * device; then the Mac downloads it through its bridge and hands it to the server.
 */
enum ChatMediaState: string
{
    /** Only on the Mac (and WhatsApp's servers); nobody asked for it here. */
    case Remote = 'remote';
    /** The user asked for it; it waits for the relaying Mac. */
    case Requested = 'requested';
    /** On the server, sealed with the owner's key; scanned before it is served. */
    case Stored = 'stored';
    /** The Mac could not bring it ({@see ChatMediaError}); the user may ask again. */
    case Failed = 'failed';
}
