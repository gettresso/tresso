<?php

declare(strict_types=1);

namespace App\Tests\Functional;

use App\Mail\Autoconfig\ServerSettingsDetector;
use App\Tests\Support\MockHttpRouter;
use App\Tests\Support\StaticMxResolver;
use App\Tests\Unit\Mail\AutoconfigParserTest;

final class MailServerSettingsTest extends DatabaseTestCase
{
    use AuthenticatesUsers;

    /** @var array<string, string> */
    private array $kim;

    protected function setUp(): void
    {
        parent::setUp();
        $this->bootstrapOAuthClients();
        $this->createUser('kim@example.test', 'Kim');
        $this->kim = $this->userHeaders('kim@example.test', ['settings:read', 'settings:write']);
        static::getContainer()->get('cache.mail_autoconfig')->clear();
    }

    public function testFindsSettingsInTheIspdb(): void
    {
        $this->router()->respond(ServerSettingsDetector::ISPDB_URL.'fastmail.com', AutoconfigParserTest::FASTMAIL);

        $settings = $this->detect('Kim@FastMail.com');

        self::assertSame([
            'emailAddress' => 'kim@fastmail.com',
            'found' => true,
            'source' => 'ispdb',
            'username' => 'kim@fastmail.com',
            'imap' => ['host' => 'imap.fastmail.com', 'port' => 993, 'security' => 'tls'],
            'smtp' => ['host' => 'smtp.fastmail.com', 'port' => 587, 'security' => 'starttls'],
            'authentication' => ['password', 'oauth2'],
            'provider' => null,
        ], $settings);
    }

    public function testPrefersTheProvidersOwnAutoconfig(): void
    {
        $own = str_replace(['imap.fastmail.com', 'IMAP.fastmail.com'], 'mail.company.example', AutoconfigParserTest::FASTMAIL);
        $this->router()->respond('https://autoconfig.company.example/mail/config-v1.1.xml', $own);
        $this->router()->respond(ServerSettingsDetector::ISPDB_URL.'company.example', AutoconfigParserTest::FASTMAIL);

        $settings = $this->detect('kim@company.example');

        self::assertSame('provider', $settings['source']);
        self::assertSame(['host' => 'mail.company.example', 'port' => 993, 'security' => 'tls'], $settings['imap']);
        self::assertContains('https://autoconfig.company.example/mail/config-v1.1.xml', $this->router()->requested(), 'The answer is cached for the domain, so the address is not sent.');
        self::assertSame([], array_filter($this->router()->requested(), static fn (string $url): bool => str_contains($url, 'kim')));
    }

    public function testAPersonalizedAnswerIsNotHandedToTheNextAddress(): void
    {
        $personal = str_replace('%EMAILADDRESS%', 'anna@company.example', AutoconfigParserTest::FASTMAIL);
        $this->router()->respond('https://autoconfig.company.example/mail/config-v1.1.xml', $personal);

        self::assertSame('anna@company.example', $this->detect('anna@company.example')['username']);
        self::assertSame('bob@company.example', $this->detect('bob@company.example')['username']);
    }

    public function testNamesTheProviderOfWellKnownDomains(): void
    {
        $expected = [
            'kim@gmail.com' => 'google',
            'kim@googlemail.com' => 'google',
            'kim@outlook.com' => 'outlook',
            'kim@hotmail.com' => 'outlook',
            'kim@live.com' => 'outlook',
            'kim@msn.com' => 'outlook',
            'kim@icloud.com' => 'icloud',
            'kim@me.com' => 'icloud',
            'kim@mac.com' => 'icloud',
            'kim@yahoo.com' => 'yahoo',
            'kim@yahoo.co.uk' => 'yahoo',
            'kim@ymail.com' => 'yahoo',
            'kim@studio-noord.example' => null,
        ];
        foreach ($expected as $address => $provider) {
            self::assertSame($provider, $this->detect($address)['provider'], $address);
        }
    }

    public function testNamesTheProviderOfACompanyDomainByItsMailExchanger(): void
    {
        $mx = static::getContainer()->get(StaticMxResolver::class);
        $mx->set('workspace.example', ['aspmx.l.google.com']);
        $mx->set('m365.example', ['m365-example.mail.protection.outlook.com']);
        $mx->set('personal.example', ['personal-example.olc.protection.outlook.com']);
        $mx->set('yahoo-hosted.example', ['mta5.am0.yahoodns.net']);
        $mx->set('apple-hosted.example', ['mx01.mail.icloud.com']);
        $mx->set('own.example', ['mail.own.example']);

        self::assertSame('google', $this->detect('kim@workspace.example')['provider']);
        self::assertSame('m365', $this->detect('kim@m365.example')['provider']);
        self::assertSame('outlook', $this->detect('kim@personal.example')['provider']);
        self::assertSame('yahoo', $this->detect('kim@yahoo-hosted.example')['provider']);
        self::assertSame('icloud', $this->detect('kim@apple-hosted.example')['provider']);
        self::assertNull($this->detect('kim@own.example')['provider']);
    }

    public function testFindsHostedMailThroughTheMailExchanger(): void
    {
        static::getContainer()->get(StaticMxResolver::class)->set('company.example', ['aspmx.l.fastmail.com']);
        $this->router()->respond(ServerSettingsDetector::ISPDB_URL.'fastmail.com', AutoconfigParserTest::FASTMAIL);

        $settings = $this->detect('kim@company.example');

        self::assertSame('ispdb-mx', $settings['source']);
        self::assertSame('kim@company.example', $settings['username']);
    }

    public function testReportsWhenNothingIsKnown(): void
    {
        $settings = $this->detect('kim@unknown.example');

        self::assertFalse($settings['found']);
        self::assertNull($settings['imap']);
        self::assertSame([], $settings['authentication']);
    }

    public function testRemembersTheAnswerPerDomain(): void
    {
        $this->router()->respond(ServerSettingsDetector::ISPDB_URL.'fastmail.com', AutoconfigParserTest::FASTMAIL);
        $this->detect('kim@fastmail.com');
        $before = \count($this->router()->requested());

        $settings = $this->detect('lisa@fastmail.com');

        self::assertSame($before, \count($this->router()->requested()));
        self::assertSame('lisa@fastmail.com', $settings['username']);
    }

    public function testAnswersCachedBeforeTheAddressWasLeftOutAreNotRead(): void
    {
        $personal = str_replace('%EMAILADDRESS%', 'anna@company.example', AutoconfigParserTest::FASTMAIL);
        static::getContainer()->get('cache.mail_autoconfig')->get('autoconfig.'.hash('sha256', 'company.example'), static fn (): array => ['xml' => $personal, 'source' => 'provider']);

        self::assertFalse($this->detect('bob@company.example')['found'], 'The old entry is not read; nothing else is known.');
    }

    public function testRejectsInvalidAddresses(): void
    {
        $this->client->request('GET', '/api/v1/mail-server-settings?emailAddress=not-an-address', server: $this->kim);
        self::assertResponseStatusCodeSame(422);

        $this->client->request('GET', '/api/v1/mail-server-settings', server: $this->kim);
        self::assertResponseStatusCodeSame(422);
    }

    public function testRequiresSettingsWriteScope(): void
    {
        $this->client->request('GET', '/api/v1/mail-server-settings?emailAddress=kim@fastmail.com', server: $this->userHeaders('kim@example.test', ['settings:read']));

        self::assertResponseStatusCodeSame(403);
    }

    /**
     * @return array<string, mixed>
     */
    private function detect(string $emailAddress): array
    {
        $this->client->request('GET', '/api/v1/mail-server-settings?'.http_build_query(['emailAddress' => $emailAddress]), server: $this->kim);
        self::assertResponseIsSuccessful();

        /** @var array<string, mixed> */
        return $this->decodedResponse();
    }

    private function router(): MockHttpRouter
    {
        return static::getContainer()->get(MockHttpRouter::class);
    }
}
