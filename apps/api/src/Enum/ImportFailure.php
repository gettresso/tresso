<?php

declare(strict_types=1);

namespace App\Enum;

use App\ProviderAuth\ConnectError;

/**
 * Why connecting an address of an import list failed, as a code with a plain sentence. The codes of a provider sign-in
 * are those of {@see ConnectError}; the server form adds its own. Codes only, so nothing a user or an app types (and no
 * password) can end up in a stored reason.
 */
enum ImportFailure: string
{
    case Denied = 'denied';
    case AdminApprovalRequired = 'admin_approval_required';
    case Expired = 'expired';
    case DifferentUser = 'different_user';
    case ScopesMissing = 'scopes_missing';
    case WrongAccount = 'wrong_account';
    case AlreadyConnected = 'already_connected';
    case UnverifiedAddress = 'unverified_address';
    case NoMailbox = 'no_mailbox';
    case Failed = 'failed';
    /** The mail server refused the username or password typed on the server form. */
    case PasswordRefused = 'password_refused';
    /** The mail server could not be reached, or did not answer like one. */
    case ServerUnreachable = 'server_unreachable';

    public static function fromConnectError(ConnectError $error): self
    {
        return self::from($error->value);
    }

    /** What went wrong, for the user and for an assistant reporting progress. */
    public function reason(): string
    {
        return match ($this) {
            self::Denied => 'The sign-in was cancelled or Tresso was not allowed at the provider.',
            self::AdminApprovalRequired => 'The organization has to approve Tresso before this account can be connected.',
            self::Expired => 'The sign-in took too long or was already used.',
            self::DifferentUser => 'The sign-in was finished by another Tresso user.',
            self::ScopesMissing => 'Tresso was not given permission to read and send mail.',
            self::WrongAccount => 'The user signed in with another account than this address.',
            self::AlreadyConnected => 'This address is already connected in another way.',
            self::UnverifiedAddress => 'The provider has not verified this address.',
            self::NoMailbox => 'This account has no mailbox Tresso can sync.',
            self::Failed => 'The provider could not be reached or answered with an error.',
            self::PasswordRefused => 'The mail server did not accept the username or password.',
            self::ServerUnreachable => 'The mail server could not be reached with these settings.',
        };
    }
}
