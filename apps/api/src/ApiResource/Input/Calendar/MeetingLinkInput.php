<?php

declare(strict_types=1);

namespace App\ApiResource\Input\Calendar;

use App\Entity\Calendar;
use Symfony\Component\Validator\Constraints as Assert;

/**
 * Ask the calendar's provider for a meeting on a saved event: "meet" (Google calendars) or "teams" (Microsoft calendars
 * with Teams), as the calendar's conferenceProviders offer.
 */
final class MeetingLinkInput
{
    #[Assert\NotBlank]
    #[Assert\Choice(choices: Calendar::CONFERENCE_PROVIDERS)]
    public string $provider = '';
}
