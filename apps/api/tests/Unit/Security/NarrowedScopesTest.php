<?php

declare(strict_types=1);

namespace App\Tests\Unit\Security;

use App\Entity\User;
use App\Security\OAuth\NarrowedScopes;
use App\Security\PersonalAccessToken\PersonalAccessTokenAuthentication;
use League\Bundle\OAuth2ServerBundle\Security\Authentication\Token\OAuth2Token;
use PHPUnit\Framework\TestCase;

/** Whose requests are narrowed to what the user allows now: an app that is not ours, and nobody else. */
final class NarrowedScopesTest extends TestCase
{
    public function testOnlyAnAppThatIsNotOursIsNarrowed(): void
    {
        $user = new User('kim@example.test', 'Kim');
        $token = static fn (string $client): OAuth2Token => new OAuth2Token($user, 'access', $client, ['mail:read'], 'ROLE_OAUTH2_');

        self::assertTrue(NarrowedScopes::narrows($token('claude-registered-client')));
        foreach (['web', 'desktop', 'mobile', 'sync-worker'] as $ours) {
            self::assertFalse(NarrowedScopes::narrows($token($ours)), $ours);
        }
        self::assertFalse(NarrowedScopes::narrows(new PersonalAccessTokenAuthentication($user, '0190b4a0-0000-7000-8000-000000000000', ['mail:read'])));
        self::assertFalse(NarrowedScopes::narrows(null));
    }
}
