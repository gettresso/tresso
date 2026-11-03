<?php

declare(strict_types=1);

namespace App\Security\OAuth;

/**
 * A client registration that is refused, with the error code of RFC 7591 3.2.2.
 */
final class ClientRegistrationRefused extends \RuntimeException
{
    public const string INVALID_REDIRECT_URI = 'invalid_redirect_uri';
    public const string INVALID_CLIENT_METADATA = 'invalid_client_metadata';

    private function __construct(public readonly string $error, string $description)
    {
        parent::__construct($description);
    }

    public static function redirectUri(string $description): self
    {
        return new self(self::INVALID_REDIRECT_URI, $description);
    }

    public static function metadata(string $description): self
    {
        return new self(self::INVALID_CLIENT_METADATA, $description);
    }
}
