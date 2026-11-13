<?php

declare(strict_types=1);

namespace App\Security;

use App\Security\PersonalAccessToken\PersonalAccessTokenAuthentication;
use League\Bundle\OAuth2ServerBundle\Security\Authentication\Token\OAuth2Token;
use Symfony\Component\Security\Core\Authentication\Token\TokenInterface;

/**
 * Which caller of the user a request comes from, for limits per caller on top of those per user: a personal access
 * token by its id, an app by its client id. Our own apps are one caller (`ours`); the user's own limits bound them.
 */
final class CallerKey
{
    public const string OURS = 'ours';

    public static function of(?TokenInterface $token): string
    {
        if (FirstPartyClients::signedRequest($token)) {
            return self::OURS;
        }
        if ($token instanceof PersonalAccessTokenAuthentication) {
            return 'pat:'.$token->getPersonalAccessTokenId();
        }
        if ($token instanceof OAuth2Token) {
            return 'client:'.$token->getOAuthClientId();
        }

        return 'other';
    }
}
