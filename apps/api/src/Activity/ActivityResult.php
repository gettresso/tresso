<?php

declare(strict_types=1);

namespace App\Activity;

/** How an action ended: done, refused before anything happened, or failed on our side. */
enum ActivityResult: string
{
    case Done = 'done';
    case Refused = 'refused';
    case Failed = 'failed';

    public function label(): string
    {
        return match ($this) {
            self::Done => 'Done',
            self::Refused => 'Refused',
            self::Failed => 'Failed',
        };
    }
}
