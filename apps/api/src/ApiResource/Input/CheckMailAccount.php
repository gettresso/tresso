<?php

declare(strict_types=1);

namespace App\ApiResource\Input;

use App\Mail\ServerSettings;
use Symfony\Component\Validator\Constraints as Assert;

/**
 * The settings of an IMAP/SMTP account to check before connecting it: what {@see CreateMailAccount} takes, without
 * the name.
 */
final class CheckMailAccount
{
    #[Assert\NotBlank]
    #[Assert\Email(mode: Assert\Email::VALIDATION_MODE_STRICT)]
    #[Assert\Length(max: 320)]
    public string $emailAddress = '';

    #[Assert\NotBlank]
    #[Assert\Length(max: 320)]
    public string $username = '';

    #[Assert\NotBlank]
    #[Assert\Length(max: 1024)]
    public string $password = '';

    #[Assert\NotNull]
    #[Assert\Valid]
    public ?ServerSettings $imap = null;

    #[Assert\NotNull]
    #[Assert\Valid]
    public ?ServerSettings $smtp = null;
}
