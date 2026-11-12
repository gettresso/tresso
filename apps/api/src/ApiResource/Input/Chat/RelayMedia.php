<?php

declare(strict_types=1);

namespace App\ApiResource\Input\Chat;

use App\Enum\ChatMediaKind;
use Symfony\Component\Validator\Constraints as Assert;

/**
 * The file a message carries, as the bridge stores it. The file itself stays on the Mac.
 */
final class RelayMedia
{
    /** The largest whole number a JavaScript client reads exactly. */
    private const int MAX_SIZE = 9_007_199_254_740_991;

    #[Assert\NotNull]
    public ?ChatMediaKind $kind = null;

    /** The file's name; stored cut to 255 characters, without control characters. */
    #[Assert\Length(max: RelayChat::MAX_FIELD)]
    public ?string $name = null;

    /** Bytes; null when the bridge does not know. */
    #[Assert\Range(min: 0, max: self::MAX_SIZE)]
    public ?int $size = null;
}
