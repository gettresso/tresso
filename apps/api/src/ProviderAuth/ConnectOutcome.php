<?php

declare(strict_types=1);

namespace App\ProviderAuth;

/**
 * What finishing a sign-in at a provider did: connected a mail account, updated a grant only (calendars allowed for
 * an account), or failed for a reason the client turns into words.
 */
final readonly class ConnectOutcome
{
    private function __construct(
        /** The mail account that was connected or signed in again. */
        public ?string $connected = null,
        /** The grant that was updated, when the sign-in was not for mail. */
        public ?string $grant = null,
        public ?ConnectError $error = null,
    ) {
    }

    public static function connected(string $mailAccountId): self
    {
        return new self(connected: $mailAccountId);
    }

    public static function grant(string $grantId): self
    {
        return new self(grant: $grantId);
    }

    public static function failed(ConnectError $error): self
    {
        return new self(error: $error);
    }
}
