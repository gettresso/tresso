<?php

declare(strict_types=1);

namespace App\Activity;

/**
 * Why an action was refused or failed: a closed set, each with the short text the log shows next to the result. The
 * sentence of an opened entry is made when the log is read ({@see ActivityDescriber}), with the app's name of then.
 */
enum ActivityReason: string
{
    /** 403: a scope the action needs is missing or switched off, or only Tresso's own apps may do it. */
    case NoPermission = 'no_permission';
    /** 401: a personal access token that had expired. */
    case TokenExpired = 'token_expired';
    /** 401: a personal access token that was revoked, or an access token of an app that was disconnected. */
    case AccessRevoked = 'access_revoked';
    /** 404: nothing with that id exists for the user. */
    case NotFound = 'not_found';
    /** 400, 405, 409, 415, 422 and other refusals of what was sent. */
    case NotAccepted = 'not_accepted';
    /** 429: a rate limit. */
    case TooManyRequests = 'too_many_requests';
    /** 402: the user's organization has no active subscription. */
    case PaymentRequired = 'payment_required';
    /** 502, 503, 504: something Tresso needs (storage, search) did not answer. */
    case Unavailable = 'unavailable';
    /** Any other 5xx, or an error in a tool. */
    case ServerError = 'server_error';

    public function label(): string
    {
        return match ($this) {
            self::NoPermission => 'No permission',
            self::TokenExpired => 'Token expired',
            self::AccessRevoked => 'Access revoked',
            self::NotFound => 'Not found',
            self::NotAccepted => 'Not accepted',
            self::TooManyRequests => 'Too many requests',
            self::PaymentRequired => 'Subscription needed',
            self::Unavailable => 'Not available right now',
            self::ServerError => 'Server error',
        };
    }

    public function result(): ActivityResult
    {
        return match ($this) {
            self::Unavailable, self::ServerError => ActivityResult::Failed,
            default => ActivityResult::Refused,
        };
    }

    /**
     * The reason of an HTTP status the API answered with, or null for a success. A 401 is not mapped here: only the
     * caller of a refused token tells whether it expired or was revoked ({@see RefusedCallers}).
     */
    public static function ofStatus(int $status): ?self
    {
        return match (true) {
            $status < 400 => null,
            402 === $status => self::PaymentRequired,
            403 === $status => self::NoPermission,
            404 === $status => self::NotFound,
            429 === $status => self::TooManyRequests,
            $status < 500 => self::NotAccepted,
            \in_array($status, [502, 503, 504], true) => self::Unavailable,
            default => self::ServerError,
        };
    }
}
