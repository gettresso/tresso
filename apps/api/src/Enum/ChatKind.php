<?php

declare(strict_types=1);

namespace App\Enum;

enum ChatKind: string
{
    /** A chat with one person. */
    case Direct = 'direct';
    /** A group chat. */
    case Group = 'group';
}
