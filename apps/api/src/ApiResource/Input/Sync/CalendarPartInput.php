<?php

declare(strict_types=1);

namespace App\ApiResource\Input\Sync;

use Symfony\Component\Validator\Constraints as Assert;

/**
 * A text/calendar part of a message (an invitation, update, cancellation or reply), as the worker found it.
 */
final class CalendarPartInput
{
    /**
     * The METHOD parameter of the part's Content-Type, when it had one. Not limited: it is the sender's text, and
     * anything that is not an iTIP method is ignored rather than refusing the message (and with it the batch).
     */
    public ?string $method = null;

    #[Assert\NotBlank]
    #[Assert\Length(max: 262144)]
    public string $ical = '';
}
