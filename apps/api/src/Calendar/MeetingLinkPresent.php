<?php

declare(strict_types=1);

namespace App\Calendar;

/**
 * Only the request for a meeting link was to be dropped, but the series has a link: it arrived after the client last
 * looked. Nothing was changed.
 */
final class MeetingLinkPresent extends \RuntimeException
{
    public function __construct()
    {
        parent::__construct('The meeting link has arrived meanwhile. Nothing was changed.');
    }
}
