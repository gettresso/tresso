<?php

declare(strict_types=1);

namespace App\Enum;

/** Why the relaying Mac could not bring a chat message's file to the server. */
enum ChatMediaError: string
{
    /** The bridge does not know the message, or it holds no file. */
    case NotFound = 'not_found';
    /** The file the bridge gave is not the one its store names (its SHA-256 differs). */
    case Mismatch = 'mismatch';
    /** The bridge's store holds no SHA-256 for the file, so the Mac could not check it. */
    case Unverified = 'unverified';
    /** Larger than the server takes. */
    case TooLarge = 'too_large';
    /**
     * The bridge was stopped or not linked, or its download failed (often because WhatsApp no longer has the file: media
     * expire on WhatsApp's servers after a while; the bridge does not say which).
     */
    case Unavailable = 'unavailable';
}
