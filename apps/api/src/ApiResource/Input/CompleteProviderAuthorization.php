<?php

declare(strict_types=1);

namespace App\ApiResource\Input;

use App\Enum\OAuthProvider;
use Symfony\Component\Validator\Constraints as Assert;

/**
 * The provider's answer to a sign-in, as the API's callback passed it on to the web app.
 */
final class CompleteProviderAuthorization
{
    #[Assert\NotNull]
    public ?OAuthProvider $provider = null;

    #[Assert\NotBlank]
    #[Assert\Length(max: 128)]
    public ?string $state = null;

    /** The authorization code, when the user allowed access. */
    #[Assert\Length(max: 4096)]
    public ?string $code = null;

    /** The provider's error code (for example access_denied), when the user did not. */
    #[Assert\Length(max: 128)]
    public ?string $error = null;
}
