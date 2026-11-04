<?php

declare(strict_types=1);

namespace App\ApiResource\Input;

use App\Enum\OAuthProvider;
use App\Enum\ProviderFeature;
use App\Enum\ProviderReturnTarget;
use Symfony\Component\Validator\Constraints as Assert;

/**
 * Starts a sign-in at Google or Microsoft.
 */
final class StartProviderAuthorization
{
    #[Assert\NotNull]
    public ?OAuthProvider $provider = null;

    /**
     * What the sign-in is for; the provider asks the user to allow exactly that.
     *
     * @var list<ProviderFeature>
     */
    #[Assert\Count(min: 1)]
    #[Assert\Unique]
    public array $features = [ProviderFeature::Mail];

    /** Signing in again for this mail account (after a failed sign-in, or to allow more). */
    #[Assert\Uuid]
    public ?string $mailAccountId = null;

    /** Where the provider's answer goes: the web app, or the desktop app that opened the system browser. */
    public ProviderReturnTarget $returnTo = ProviderReturnTarget::Web;
}
