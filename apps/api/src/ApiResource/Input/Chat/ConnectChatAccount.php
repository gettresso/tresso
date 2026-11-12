<?php

declare(strict_types=1);

namespace App\ApiResource\Input\Chat;

use App\Entity\ChatAccount;
use Symfony\Component\Validator\Constraints as Assert;

/**
 * The desktop app connects the user's WhatsApp to the server ("All my devices"), or makes itself the relay of an
 * account that exists. On an existing account only the device and the own number and name change; `includeGroups`
 * and `notify` are taken when the account is made.
 */
final class ConnectChatAccount
{
    /** An id the desktop app made once for itself. */
    #[Assert\NotBlank]
    #[Assert\Uuid]
    public string $deviceId = '';

    #[Assert\NotBlank(normalizer: 'trim')]
    #[Assert\Length(min: 1, max: ChatAccount::MAX_DEVICE_NAME)]
    public string $deviceName = '';

    /** The own number, digits only; null when the desktop does not know it. */
    #[Assert\Regex('/^[0-9]{5,20}$/D', message: 'The number is 5 to 20 digits, without a plus or spaces.')]
    public ?string $address = null;

    #[Assert\Length(max: 255)]
    public ?string $displayName = null;

    public bool $includeGroups = true;

    public bool $notify = false;
}
