<?php

declare(strict_types=1);

namespace App\ApiResource\Input\Calendar;

use App\Calendar\MeetingLinkAddress;
use App\Entity\MeetingPreferences;
use Symfony\Component\Validator\Constraints as Assert;

/**
 * Partial update (JSON merge patch). Omitted or null fields stay as they are; an empty ownLink clears the link.
 * `defaults` and `disabled` replace the whole map or list. The processor checks the link's form and the mail accounts.
 */
final class UpdateMeetingPreferences
{
    #[Assert\Length(max: MeetingLinkAddress::MAX_LENGTH, maxMessage: 'Use a link of at most 2048 characters.')]
    public ?string $ownLink = null;

    public ?bool $addWithGuests = null;

    /** @var array<mixed>|null mail account id to one of MeetingPreferences::DEFAULTS */
    public ?array $defaults = null;

    #[Assert\Choice(choices: MeetingPreferences::DEFAULTS, message: 'Use meet, teams, zoom, own or none.')]
    public ?string $defaultOther = null;

    /** @var array<mixed>|null list of {app, mailAccountId} */
    public ?array $disabled = null;
}
