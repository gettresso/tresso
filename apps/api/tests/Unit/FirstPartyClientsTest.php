<?php

declare(strict_types=1);

namespace App\Tests\Unit;

use App\Entity\User;
use App\Security\FirstPartyClients;
use App\Security\PersonalAccessToken\PersonalAccessTokenAuthentication;
use League\Bundle\OAuth2ServerBundle\Security\Authentication\Token\OAuth2Token;
use League\Bundle\OAuth2ServerBundle\Security\User\ClientCredentialsUser;
use PHPUnit\Framework\TestCase;

final class FirstPartyClientsTest extends TestCase
{
    public function testOurOwnAppsAreFirstParty(): void
    {
        foreach (['web', 'desktop', 'mobile'] as $client) {
            self::assertTrue(FirstPartyClients::signedRequest(new OAuth2Token(new User('kim@example.test', 'Kim'), 'access', $client, ['settings:write'], 'ROLE_OAUTH2_')), $client);
        }
    }

    public function testOtherClientsAreNot(): void
    {
        self::assertFalse(FirstPartyClients::signedRequest(null));
        self::assertFalse(FirstPartyClients::signedRequest(new OAuth2Token(new User('kim@example.test', 'Kim'), 'access', 'some-third-party-app', ['settings:write'], 'ROLE_OAUTH2_')));
        self::assertFalse(FirstPartyClients::signedRequest(new OAuth2Token(new ClientCredentialsUser('sync-worker'), 'access', 'sync-worker', ['sync:lease'], 'ROLE_OAUTH2_')));
    }

    public function testAPersonalAccessTokenIsNeverFirstParty(): void
    {
        $token = new PersonalAccessTokenAuthentication(new User('kim@example.test', 'Kim'), '0190b4a0-0000-7000-8000-000000000000', ['settings:read', 'settings:write']);

        self::assertFalse(FirstPartyClients::signedRequest($token));
        self::assertFalse(FirstPartyClients::isFirstParty($token->getOAuthClientId()));
        self::assertSame(['ROLE_OAUTH2_SETTINGS:READ', 'ROLE_OAUTH2_SETTINGS:WRITE', 'ROLE_USER'], $token->getRoleNames(), 'The same roles as an OAuth2 access token with these scopes.');
    }
}
