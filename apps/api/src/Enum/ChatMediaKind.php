<?php

declare(strict_types=1);

namespace App\Enum;

/** The kind of file a chat message carries. */
enum ChatMediaKind: string
{
    case Image = 'image';
    case Video = 'video';
    /** A voice message or another sound file. */
    case Audio = 'audio';
    case Document = 'document';
}
