<?php

declare(strict_types=1);

namespace App\ProviderAuth;

/**
 * Why connecting through a provider failed, as a code the client turns into words (codes rather than text, so a
 * crafted link cannot put arbitrary messages on the client's screen).
 */
enum ConnectError: string
{
    /** The user cancelled or refused at the provider. */
    case Denied = 'denied';
    /** The user's organization lets its users allow only apps an administrator approved, and Tresso is not one yet. */
    case AdminApprovalRequired = 'admin_approval_required';
    /** The sign-in took too long, was already used, or was not started by this browser. */
    case Expired = 'expired';
    /** The browser is signed in to Tresso as someone other than the user who started the sign-in. */
    case DifferentUser = 'different_user';
    /** The user unticked a permission Tresso needs. */
    case ScopesMissing = 'scopes_missing';
    /** Signing in again for an account, but with another provider account. */
    case WrongAccount = 'wrong_account';
    /** The address is already connected with a password (IMAP). */
    case AlreadyConnected = 'already_connected';
    /** The provider has not verified the account's address. */
    case UnverifiedAddress = 'unverified_address';
    /** The provider account has no mailbox. */
    case NoMailbox = 'no_mailbox';
    /** The provider could not be reached or answered with an error. */
    case Failed = 'failed';
}
