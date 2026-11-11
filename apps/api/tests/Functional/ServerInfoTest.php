<?php

declare(strict_types=1);

namespace App\Tests\Functional;

final class ServerInfoTest extends DatabaseTestCase
{
    use AuthenticatesUsers;

    /**
     * The test environment allows local mail servers (MAIL_ALLOW_UNSAFE_SERVERS=1), so apps may offer "None" as the
     * connection security there; a production server says false.
     */
    public function testSaysWhetherUnencryptedMailServersMayBeSaved(): void
    {
        $this->client->request('GET', '/api/v1/server-info');

        self::assertResponseIsSuccessful();
        self::assertTrue($this->decodedResponse()['allowUnencryptedMailServers'] ?? null);
    }
}
