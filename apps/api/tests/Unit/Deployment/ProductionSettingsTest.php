<?php

declare(strict_types=1);

namespace App\Tests\Unit\Deployment;

use App\Deployment\ProductionSettings;
use PHPUnit\Framework\Attributes\DataProvider;
use PHPUnit\Framework\TestCase;

final class ProductionSettingsTest extends TestCase
{
    private const array DEVELOPMENT = [
        'OAUTH_PASSPHRASE' => ['f667878f34f7ce2881fe40e9ef935793'],
        'DATA_KEYS' => ['dev:BAlSUjZIooXa8NYJsDBsKuMkgeoFrfxeKgrNTqBRESY=', 'test:'.self::TEST_KEY],
        'DATABASE_URL' => ['postgresql://app:!ChangeMe!@127.0.0.1:5432/app'],
        'APP_SECRET' => ['', '541a17188094e0df15c2125ec8579b41'],
        'GOOGLE_OAUTH_CLIENT_SECRET' => ['', 'test-google-secret'],
    ];

    private const string TEST_KEY = 'dGVzdC10ZXN0LXRlc3QtdGVzdC10ZXN0LXRlc3QtMTI=';

    public function testCompleteSettingsMayStart(): void
    {
        self::assertSame([], new ProductionSettings(self::complete(), self::DEVELOPMENT)->problems());
    }

    public function testAMissingSecretStopsTheStart(): void
    {
        $settings = self::complete();
        unset($settings['SYNC_WORKER_CLIENT_SECRET']);
        $settings['APP_SECRET'] = '  ';

        self::assertSame(
            ['APP_SECRET is not set.', 'SYNC_WORKER_CLIENT_SECRET is not set.'],
            new ProductionSettings($settings, self::DEVELOPMENT)->problems(),
        );
    }

    public function testDevelopmentAndExampleValuesStopTheStart(): void
    {
        $settings = [
            ...self::complete(),
            'OAUTH_PASSPHRASE' => self::DEVELOPMENT['OAUTH_PASSPHRASE'][0],
            'MEILISEARCH_KEY' => 'dev-master-key-change-me',
            'APP_SECRET' => self::DEVELOPMENT['APP_SECRET'][1],
        ];

        self::assertSame([
            'APP_SECRET is still a development or example value; generate a new one.',
            'OAUTH_PASSPHRASE is still a development or example value; generate a new one.',
            'MEILISEARCH_KEY is still a development or example value; generate a new one.',
        ], new ProductionSettings($settings, self::DEVELOPMENT)->problems());
    }

    public function testTheDevelopmentDataKeyIsNeverUsed(): void
    {
        foreach ([['dev:BAlSUjZIooXa8NYJsDBsKuMkgeoFrfxeKgrNTqBRESY=', 'dev'], ['test:'.self::TEST_KEY, 'test']] as [$keys, $current]) {
            $settings = [...self::complete(), 'DATA_KEYS' => $keys, 'DATA_KEY_CURRENT' => $current];

            self::assertSame(
                ['DATA_KEYS is still the development key: mail would be encrypted with a public key.'],
                new ProductionSettings($settings, self::DEVELOPMENT)->problems(),
            );
        }
    }

    public function testDataKeysMustBeValid(): void
    {
        $settings = [...self::complete(), 'DATA_KEY_CURRENT' => 'other'];

        self::assertSame(
            ['DATA_KEY_CURRENT "other" is not present in DATA_KEYS.'],
            new ProductionSettings($settings, self::DEVELOPMENT)->problems(),
        );
    }

    public function testShortSecretsStopTheStart(): void
    {
        $settings = [...self::complete(), 'MERCURE_PUBLISHER_JWT_KEY' => 'too-short'];

        self::assertSame(
            ['MERCURE_PUBLISHER_JWT_KEY must be at least 32 characters.'],
            new ProductionSettings($settings, self::DEVELOPMENT)->problems(),
        );
    }

    public function testTheMercureKeysMustDiffer(): void
    {
        $settings = self::complete();
        $settings['MERCURE_SUBSCRIBER_JWT_KEY'] = $settings['MERCURE_PUBLISHER_JWT_KEY'];

        self::assertSame(
            ['MERCURE_PUBLISHER_JWT_KEY and MERCURE_SUBSCRIBER_JWT_KEY must differ: subscribers could publish.'],
            new ProductionSettings($settings, self::DEVELOPMENT)->problems(),
        );
    }

    public function testTheExampleDatabaseAndUnsafeMailServersStopTheStart(): void
    {
        $settings = [...self::complete(), 'DATABASE_URL' => self::DEVELOPMENT['DATABASE_URL'][0], 'MAIL_ALLOW_UNSAFE_SERVERS' => '1'];

        self::assertSame([
            'DATABASE_URL is not set to your database.',
            'MAIL_ALLOW_UNSAFE_SERVERS must be 0: it would let users point the sync workers at internal services.',
        ], new ProductionSettings($settings, self::DEVELOPMENT)->problems());
    }

    public function testOptionalSecretsMayBeEmptyButNotDevelopmentValues(): void
    {
        self::assertSame([], new ProductionSettings([...self::complete(), 'GOOGLE_OAUTH_CLIENT_SECRET' => ''], self::DEVELOPMENT)->problems());
        self::assertSame(
            ['GOOGLE_OAUTH_CLIENT_SECRET is still a development or example value; set your own or leave it empty.'],
            new ProductionSettings([...self::complete(), 'GOOGLE_OAUTH_CLIENT_SECRET' => 'test-google-secret'], self::DEVELOPMENT)->problems(),
        );
    }

    public function testAWeakDatabasePasswordStopsTheStart(): void
    {
        $settings = [...self::complete(), 'DATABASE_URL' => 'postgresql://app:app@postgres:5432/app?serverVersion=18'];

        self::assertSame(
            ['The database password in DATABASE_URL must be at least 16 characters.'],
            new ProductionSettings($settings, self::DEVELOPMENT)->problems(),
        );
    }

    /** @return iterable<string, array{string}> */
    public static function addressesThatAreNotAnOrigin(): iterable
    {
        yield 'trailing slash' => ['https://mail.example.com/'];
        yield 'path' => ['https://mail.example.com/tresso'];
        yield 'plain http' => ['http://mail.example.com'];
        yield 'no scheme' => ['mail.example.com'];
    }

    #[DataProvider('addressesThatAreNotAnOrigin')]
    public function testTheWebAddressMustBeABareHttpsOrigin(string $address): void
    {
        $settings = [...self::complete(), 'WEB_APP_URL' => $address];

        self::assertSame(
            ['WEB_APP_URL must be an https address without a path or trailing slash, such as https://mail.example.com.'],
            new ProductionSettings($settings, self::DEVELOPMENT)->problems(),
        );
    }

    public function testCorsIsAListOfOriginsThatIncludesTheWebClient(): void
    {
        self::assertSame(
            ['CORS_ALLOW_ORIGIN must list origins separated by spaces, not a regular expression.'],
            new ProductionSettings([...self::complete(), 'CORS_ALLOW_ORIGIN' => '^https://mail\\.example\\.com$'], self::DEVELOPMENT)->problems(),
        );
        self::assertSame(
            ['CORS_ALLOW_ORIGIN does not list WEB_APP_URL, so the web client cannot call the API.'],
            new ProductionSettings([...self::complete(), 'CORS_ALLOW_ORIGIN' => 'https://other.example tauri://localhost'], self::DEVELOPMENT)->problems(),
        );
        self::assertSame(
            [
                'CORS_ALLOW_ORIGIN lists "https://*.example.com", which is not an https origin such as https://mail.example.com.',
                'CORS_ALLOW_ORIGIN lists "http://intranet.example", which is not an https origin such as https://mail.example.com.',
            ],
            new ProductionSettings([...self::complete(), 'CORS_ALLOW_ORIGIN' => 'https://mail.example.com https://*.example.com http://intranet.example'], self::DEVELOPMENT)->problems(),
        );
    }

    public function testTheApiAddressMustBeABareHttpsOriginToo(): void
    {
        foreach (['https://api.mail.example.com/', 'https://api.mail.example.com/x', 'https://api.mail.example.com?x=1', 'https://api.mail.example.com#x', 'https://user@api.mail.example.com', 'https://api.mail.example.com:', 'https://api.mail.example.com:0', 'https://api.mail.example.com:70000'] as $address) {
            self::assertSame(
                ['API_PUBLIC_URL must be an https address without a path or trailing slash, such as https://mail.example.com.'],
                new ProductionSettings([...self::complete(), 'API_PUBLIC_URL' => $address], self::DEVELOPMENT)->problems(),
                $address,
            );
        }
        self::assertSame([], new ProductionSettings([...self::complete(), 'API_PUBLIC_URL' => 'https://api.mail.example.com:8443'], self::DEVELOPMENT)->problems());
    }

    public function testProblemsNeverContainASecret(): void
    {
        $settings = [...self::complete(), 'S3_SECRET_KEY' => 'short-secret'];

        $problems = implode("\n", new ProductionSettings($settings, self::DEVELOPMENT)->problems());

        self::assertStringContainsString('S3_SECRET_KEY', $problems);
        self::assertStringNotContainsString('short-secret', $problems);
    }

    /** @return array<string, string> */
    private static function complete(): array
    {
        return [
            'APP_SECRET' => str_repeat('a', 32),
            'OAUTH_PASSPHRASE' => str_repeat('b', 32),
            'OAUTH_ENCRYPTION_KEY' => str_repeat('c', 32),
            'SYNC_WORKER_CLIENT_SECRET' => str_repeat('d', 32),
            'MERCURE_PUBLISHER_JWT_KEY' => str_repeat('e', 32),
            'MERCURE_SUBSCRIBER_JWT_KEY' => str_repeat('f', 32),
            'MEILISEARCH_KEY' => str_repeat('g', 32),
            'S3_ACCESS_KEY' => 'tresso',
            'S3_SECRET_KEY' => str_repeat('h', 32),
            'DATA_KEYS' => 'k1:'.base64_encode(str_repeat('k', 32)),
            'DATA_KEY_CURRENT' => 'k1',
            'DATABASE_URL' => 'postgresql://tresso:'.str_repeat('p', 32).'@postgres:5432/tresso?serverVersion=18&charset=utf8',
            'MAIL_ALLOW_UNSAFE_SERVERS' => '0',
            'WEB_APP_URL' => 'https://mail.example.com',
            'API_PUBLIC_URL' => 'https://api.mail.example.com',
            'CORS_ALLOW_ORIGIN' => 'https://mail.example.com tauri://localhost http://tauri.localhost',
        ];
    }
}
