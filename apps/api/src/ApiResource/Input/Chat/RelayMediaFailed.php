<?php

declare(strict_types=1);

namespace App\ApiResource\Input\Chat;

use App\Enum\ChatMediaError;
use Symfony\Component\Validator\Constraints as Assert;

/**
 * Why the relay could not bring a file it was asked for. The user may ask again.
 */
final class RelayMediaFailed extends RelayRequest
{
    #[Assert\NotNull]
    public ?ChatMediaError $error = null;
}
