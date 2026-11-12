<?php

declare(strict_types=1);

namespace App\ApiResource\Input\Chat;

use Symfony\Component\Validator\Constraints as Assert;

/**
 * Every call of the relay names the desktop that makes it: only the account's relaying device is answered
 * ({@see \App\Chat\ChatRelayGuard}); another one gets 409 `not_the_relay` until it takes over through
 * `PUT /api/v1/chat-accounts/whatsapp`.
 */
abstract class RelayRequest
{
    /** The id the desktop app made once for itself. */
    #[Assert\NotBlank]
    #[Assert\Uuid]
    public string $deviceId = '';
}
