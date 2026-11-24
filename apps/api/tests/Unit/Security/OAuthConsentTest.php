<?php

declare(strict_types=1);

namespace App\Tests\Unit\Security;

use App\Entity\OAuthConsent;
use App\Entity\User;
use League\Bundle\OAuth2ServerBundle\Model\Client;
use PHPUnit\Framework\TestCase;

/**
 * A consent keeps what the user granted on the consent screen apart from what they switched off later.
 */
final class OAuthConsentTest extends TestCase
{
    public function testSwitchingOffKeepsTheGrantAndSwitchingOnNeedsIt(): void
    {
        $consent = $this->consent(['mail:read', 'settings:read', 'chat:read']);

        self::assertSame(['settings:read'], $consent->narrow(['mail:read', 'chat:read']), 'It says what was switched off.');
        self::assertSame(['mail:read', 'settings:read', 'chat:read'], $consent->getScopes());
        self::assertSame(['mail:read', 'chat:read'], $consent->getAllowedScopes());
        self::assertSame(['settings:read'], $consent->getDisabledScopes());
        self::assertTrue($consent->covers(['settings:read']), 'A switched-off scope is still granted, so the app is not sent to the consent screen for it.');

        self::assertSame([], $consent->narrow(['mail:read', 'settings:read', 'chat:read']));
        self::assertSame(['mail:read', 'settings:read', 'chat:read'], $consent->getAllowedScopes());

        $this->expectException(\InvalidArgumentException::class);
        $consent->narrow(['mail:read', 'mail:send']);
    }

    public function testTheConsentScreenDoesNotUndoASwitch(): void
    {
        $consent = $this->consent(['mail:read', 'settings:read']);
        $consent->narrow(['mail:read']);

        $consent->allow(['mail:read', 'settings:read', 'todos:read']);

        self::assertSame(['mail:read', 'todos:read'], $consent->getAllowedScopes(), 'Only what was never granted before is added.');
        self::assertSame(['settings:read'], $consent->getDisabledScopes());
    }

    public function testAWithdrawnScopeIsNoLongerSwitchedOff(): void
    {
        $consent = $this->consent(['mail:read', 'chat:read']);
        $consent->narrow(['mail:read']);

        self::assertSame(['chat:read'], $consent->withdraw(['chat:read']));
        self::assertSame([], $consent->getDisabledScopes());
        self::assertSame(['mail:read'], $consent->getAllowedScopes());
    }

    /**
     * @param list<string> $scopes
     */
    private function consent(array $scopes): OAuthConsent
    {
        return new OAuthConsent(new User('kim@example.test', 'Kim'), new Client('Some app', 'some-app', null), $scopes, new \DateTimeImmutable());
    }
}
