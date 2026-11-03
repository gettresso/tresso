<?php

declare(strict_types=1);

namespace App\Security\PersonalAccessToken;

use League\Bundle\OAuth2ServerBundle\Security\Authentication\Token\OAuth2Token;
use Symfony\Component\Security\Core\User\UserInterface;

/**
 * The security token of a request signed with a personal access token. It is an {@see OAuth2Token} on purpose: the
 * roles come from the scopes exactly as for an OAuth2 access token, so `is_granted()` checks, voters and code that reads
 * the scopes work unchanged. Its client id is {@see CLIENT_ID}, which is no OAuth2 client, so it is never taken for a
 * first-party app or a sync worker.
 */
final class PersonalAccessTokenAuthentication extends OAuth2Token
{
    public const string CLIENT_ID = 'personal-access-token';

    /**
     * @param list<string> $scopes
     */
    public function __construct(UserInterface $user, string $personalAccessTokenId, array $scopes)
    {
        parent::__construct($user, 'pat:'.$personalAccessTokenId, self::CLIENT_ID, $scopes, 'ROLE_OAUTH2_');
        $this->setAttribute('personal_access_token_id', $personalAccessTokenId);
    }

    public function getPersonalAccessTokenId(): string
    {
        /** @var string */
        return $this->getAttribute('personal_access_token_id');
    }
}
