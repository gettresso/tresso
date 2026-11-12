<?php

declare(strict_types=1);

namespace App\ApiResource\Input\Chat;

use Symfony\Component\Validator\Constraints as Assert;

/**
 * Who wrote a message in a group: the number or JID the bridge stores, and the name the desktop found for it.
 */
final class RelaySender
{
    #[Assert\NotBlank]
    #[Assert\Regex('/^[\x21-\x7E]{1,128}$/D', message: 'A sender is a number or a JID of at most 128 characters.')]
    public string $id = '';

    /** Stored cut to 255 characters, without control characters. */
    #[Assert\Length(max: RelayChat::MAX_FIELD)]
    public ?string $name = null;
}
