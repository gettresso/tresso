<?php

declare(strict_types=1);

namespace App\Tests\Functional;

use App\Deployment\PublicAddresses;

/**
 * A server without a web app (WEB_APP_URL empty) has no page to add accounts on: it makes no import list, and stores
 * nothing before it says so.
 */
final class MailAccountImportWithoutWebAppTest extends DatabaseTestCase
{
    use AuthenticatesUsers;
    use ConnectsThirdPartyApps;
    use SeedsAccessTokens;

    protected function setUp(): void
    {
        parent::setUp();
        // Before the first request, which builds the public addresses from the environment.
        static::getContainer()->set(PublicAddresses::class, new PublicAddresses('http://localhost', '', '', true, ''));
        $this->createUser('kim@example.test', 'Kim Visser');
    }

    public function testNoListIsStoredWithoutAWebAppToOpenIt(): void
    {
        $headers = $this->seededThirdPartyHeaders('kim@example.test', ['settings:read', 'settings:write']);

        $this->client->jsonRequest('POST', '/api/v1/mail-account-imports', ['entries' => [['address' => 'anna@partner.example']]], $headers);

        self::assertResponseStatusCodeSame(503);
        self::assertStringContainsString('WEB_APP_URL', (string) $this->client->getResponse()->getContent());
        self::assertSame(0, $this->countRows('SELECT COUNT(*) FROM mail_account_import'));
    }
}
