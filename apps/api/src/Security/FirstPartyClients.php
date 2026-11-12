<?php

declare(strict_types=1);

namespace App\Security;

use App\Command\BootstrapOAuthClientsCommand;
use App\Security\PersonalAccessToken\PersonalAccessTokenAuthentication;
use League\Bundle\OAuth2ServerBundle\Security\Authentication\Token\OAuth2Token;
use Symfony\Component\Security\Core\Authentication\Token\TokenInterface;

/**
 * Our own apps: web, desktop and mobile. They are approved without a consent screen, and only they may do what a
 * user should only do in Tresso itself, such as managing personal access tokens. The sync worker is first-party too,
 * but has no user and is not one of these.
 */
final class FirstPartyClients
{
    /** Security attribute: the request comes from one of our own apps, on behalf of a user. */
    public const string ATTRIBUTE = 'FIRST_PARTY_CLIENT';

    /** Security attribute: the request comes from our desktop app, on behalf of a user (it alone relays chats). */
    public const string DESKTOP_ATTRIBUTE = 'DESKTOP_CLIENT';

    public const array IDENTIFIERS = [
        BootstrapOAuthClientsCommand::WEB,
        BootstrapOAuthClientsCommand::DESKTOP,
        BootstrapOAuthClientsCommand::MOBILE,
    ];

    public static function isFirstParty(string $clientIdentifier): bool
    {
        return \in_array($clientIdentifier, self::IDENTIFIERS, true);
    }

    /**
     * Whether the request was signed with an OAuth2 access token issued to one of our own apps. Personal access tokens
     * never are, whatever they hold.
     */
    public static function signedRequest(?TokenInterface $token): bool
    {
        return $token instanceof OAuth2Token
            && !$token instanceof PersonalAccessTokenAuthentication
            && self::isFirstParty($token->getOAuthClientId());
    }

    /** Whether the request was signed with an OAuth2 access token issued to our desktop app. */
    public static function signedByDesktop(?TokenInterface $token): bool
    {
        return self::signedRequest($token)
            && $token instanceof OAuth2Token
            && BootstrapOAuthClientsCommand::DESKTOP === $token->getOAuthClientId();
    }
}
