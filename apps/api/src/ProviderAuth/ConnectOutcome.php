<?php

declare(strict_types=1);

namespace App\ProviderAuth;

use App\Enum\ProviderFeature;

/**
 * What finishing a sign-in at a provider did: connected a mail account, updated a grant only (calendars allowed for
 * an account), or failed for a reason the client turns into words.
 */
final readonly class ConnectOutcome
{
    /**
     * @param list<ProviderFeature> $requested what the sign-in asked for; empty when the sign-in was not known
     * @param list<ProviderFeature> $missing   what was asked for but not allowed at the provider (calendars left unticked)
     */
    private function __construct(
        /** The mail account that was connected or signed in again. */
        public ?string $connected = null,
        /** The grant that was updated, when the sign-in was not for mail. */
        public ?string $grant = null,
        public ?ConnectError $error = null,
        public array $requested = [],
        public array $missing = [],
        /** A new sign-in found the account connected already, and signed it in again. */
        public bool $existing = false,
        /** Where an administrator approves Tresso for the organization ({@see ConnectError::AdminApprovalRequired}). */
        public ?string $approvalUrl = null,
    ) {
    }

    /**
     * @param list<ProviderFeature> $requested
     * @param list<ProviderFeature> $missing
     */
    public static function connected(string $mailAccountId, array $requested, array $missing, bool $existing): self
    {
        return new self(connected: $mailAccountId, requested: $requested, missing: $missing, existing: $existing);
    }

    /**
     * @param list<ProviderFeature> $requested
     * @param list<ProviderFeature> $missing
     */
    public static function grant(string $grantId, array $requested, array $missing): self
    {
        return new self(grant: $grantId, requested: $requested, missing: $missing);
    }

    /**
     * @param list<ProviderFeature> $requested
     */
    public static function failed(ConnectError $error, array $requested = [], ?string $approvalUrl = null): self
    {
        return new self(error: $error, requested: $requested, approvalUrl: $approvalUrl);
    }
}
