<?php

declare(strict_types=1);

namespace App\ApiResource\Input\Chat;

/**
 * What the user changes of a chat account; a field left out stays as it is.
 */
final class UpdateChatAccount
{
    /** False removes the account's group chats from the server, and the relay leaves groups out from then on. */
    public ?bool $includeGroups = null;

    public ?bool $notify = null;
}
