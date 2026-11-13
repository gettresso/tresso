<?php

declare(strict_types=1);

namespace App\ApiResource\Input\Chat;

use App\Chat\ChatTime;
use App\Enum\ChatBridgeState;
use App\Enum\ChatLinkState;
use Symfony\Component\Validator\Constraints as Assert;

/**
 * The relay's heartbeat: what it sees of the bridge, sent on connect, on every change and every minute. The account
 * changes for clients only when one of these values differs from what it holds.
 */
final class RelayStatus extends RelayRequest
{
    #[Assert\NotNull]
    public ?ChatBridgeState $bridge = null;

    #[Assert\NotNull]
    public ?ChatLinkState $link = null;

    /** When the relay saw the bridge get linked; null when it did not see it happen. */
    #[Assert\GreaterThanOrEqual(ChatTime::EARLIEST, message: 'This time lies before WhatsApp existed.')]
    #[Assert\LessThanOrEqual(ChatTime::MAX_AHEAD, message: 'This time lies in the future; check the clock of this device.')]
    public ?\DateTimeImmutable $linkedAt = null;

    /** Whether the bridge listens on loopback only; null when the relay could not check. */
    public ?bool $loopbackOnly = null;

    /**
     * The number the bridge is linked to, digits only; null when the relay does not know it. Another number than the
     * account's is 409 `other_number`: the relay stops (it took over not knowing its number, and has learned it since).
     */
    #[Assert\NotBlank(allowNull: true)]
    #[Assert\Regex('/^[0-9]{5,20}$/D', message: 'The number is 5 to 20 digits, without a plus or spaces.')]
    public ?string $address = null;
}
