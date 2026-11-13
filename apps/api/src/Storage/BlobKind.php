<?php

declare(strict_types=1);

namespace App\Storage;

/** What an object holds; the first part of its key. */
enum BlobKind: string
{
    /** A received message's raw MIME, stored by the sync worker. */
    case Raw = 'raw';
    /** A received attachment, decoded, stored by the sync worker. */
    case Attachments = 'attachments';
    /** A file uploaded to a draft. */
    case Uploads = 'uploads';
    /** An outgoing message as it is sent. */
    case Outgoing = 'outgoing';
    /** A draft's copy for the account's Drafts folder. */
    case Drafts = 'drafts';
    /**
     * A WhatsApp file: one the relaying Mac brought for the user's other devices, or one a browser or phone uploaded
     * for a reply ({@see \App\Chat\ChatMedia}, {@see \App\Chat\ChatUploads}).
     */
    case ChatMedia = 'chatmedia';
    /** Infected content, out of reach of downloads. */
    case Quarantine = 'quarantine';
}
