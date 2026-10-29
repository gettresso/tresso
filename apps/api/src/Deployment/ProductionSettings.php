<?php

declare(strict_types=1);

namespace App\Deployment;

use App\Security\Crypto\CryptoException;
use App\Security\Crypto\KeyRing;

/**
 * Whether a production server's settings are safe to start with. The repository's .env files hold development values
 * that are public; a production image falls back to them when a setting is missing, so every secret has to be set,
 * long enough, and not one of those values.
 */
final readonly class ProductionSettings
{
    /** Secrets with the minimum length each needs. */
    public const array SECRETS = [
        'APP_SECRET' => 32,
        'OAUTH_PASSPHRASE' => 16,
        'OAUTH_ENCRYPTION_KEY' => 32,
        'SYNC_WORKER_CLIENT_SECRET' => 32,
        'MERCURE_PUBLISHER_JWT_KEY' => 32,
        'MERCURE_SUBSCRIBER_JWT_KEY' => 32,
        'MEILISEARCH_KEY' => 16,
        'S3_ACCESS_KEY' => 3,
        'S3_SECRET_KEY' => 16,
    ];

    /** Secrets a server may leave empty, but never set to a development value. */
    public const array OPTIONAL_SECRETS = [
        'GOOGLE_OAUTH_CLIENT_SECRET',
        'MICROSOFT_OAUTH_CLIENT_SECRET',
        'WEB_PUSH_PRIVATE_KEY',
        'EXPO_ACCESS_TOKEN',
    ];

    /** Addresses that must be a bare origin: links, OAuth redirects and the realtime hub are built on them. */
    public const array ORIGINS = ['WEB_APP_URL', 'API_PUBLIC_URL'];

    /** Placeholder spellings the example settings use. */
    private const string PLACEHOLDER = '/change-?me/i';

    /**
     * @param array<string, string>       $settings    the environment the server runs with
     * @param array<string, list<string>> $development every value the repository's .env files give each setting
     */
    public function __construct(
        #[\SensitiveParameter]
        private array $settings,
        #[\SensitiveParameter]
        private array $development,
    ) {
    }

    /**
     * What is wrong, one line per problem; empty when the server may start. Never contains a secret's value.
     *
     * @return list<string>
     */
    public function problems(): array
    {
        $problems = [];
        foreach (self::SECRETS as $name => $length) {
            $problem = $this->secretProblem($name, $length);
            if (null !== $problem) {
                $problems[] = $problem;
            }
        }

        $publisher = $this->value('MERCURE_PUBLISHER_JWT_KEY');
        if ('' !== $publisher && $publisher === $this->value('MERCURE_SUBSCRIBER_JWT_KEY')) {
            $problems[] = 'MERCURE_PUBLISHER_JWT_KEY and MERCURE_SUBSCRIBER_JWT_KEY must differ: subscribers could publish.';
        }

        foreach (self::OPTIONAL_SECRETS as $name) {
            if ($this->isDevelopmentValue($name, $this->value($name))) {
                $problems[] = \sprintf('%s is still a development or example value; set your own or leave it empty.', $name);
            }
        }

        $problems = [...$problems, ...$this->dataKeyProblems(), ...$this->originProblems()];

        $database = $this->value('DATABASE_URL');
        $password = rawurldecode((string) parse_url($database, \PHP_URL_PASS));
        if ('' === $database || 1 === preg_match(self::PLACEHOLDER, $database) || $this->isDevelopmentValue('DATABASE_URL', $database)) {
            $problems[] = 'DATABASE_URL is not set to your database.';
        } elseif (\strlen($password) < 16) {
            $problems[] = 'The database password in DATABASE_URL must be at least 16 characters.';
        }

        if (!\in_array($this->value('MAIL_ALLOW_UNSAFE_SERVERS'), ['', '0'], true)) {
            $problems[] = 'MAIL_ALLOW_UNSAFE_SERVERS must be 0: it would let users point the sync workers at internal services.';
        }

        return $problems;
    }

    /** @return list<string> */
    private function originProblems(): array
    {
        $problems = [];
        foreach (self::ORIGINS as $name) {
            $value = $this->value($name);
            $parts = parse_url($value);
            if (!\is_array($parts) || 'https' !== ($parts['scheme'] ?? null) || !isset($parts['host'])
                || isset($parts['path']) || isset($parts['query']) || isset($parts['fragment']) || isset($parts['user'])) {
                $problems[] = \sprintf('%s must be an https address without a path or trailing slash, such as https://mail.example.com.', $name);
            }
        }

        $cors = $this->value('CORS_ALLOW_ORIGIN');
        $web = $this->value('WEB_APP_URL');
        $pattern = '{'.$cors.'}i';
        if (!str_starts_with($cors, '^') || !str_ends_with($cors, '$')) {
            $problems[] = 'CORS_ALLOW_ORIGIN must start with ^ and end with $, or other sites that contain the address match too.';
        } elseif (false === @preg_match($pattern, '')) {
            $problems[] = 'CORS_ALLOW_ORIGIN is not a valid regular expression.';
        } elseif ('' !== $web && 1 !== preg_match($pattern, $web)) {
            $problems[] = 'CORS_ALLOW_ORIGIN does not allow WEB_APP_URL, so the web client cannot call the API.';
        } elseif ('' !== $web && (1 === preg_match($pattern, 'https://tresso-check.invalid') || 1 === preg_match($pattern, $web.'.tresso-check.invalid'))) {
            // Every alternative needs its own anchors: ^a|b$ lets any origin ending in b through.
            $problems[] = 'CORS_ALLOW_ORIGIN also allows other sites; anchor every alternative, such as ^(https://mail\\.example\\.com|tauri://localhost)$.';
        }

        return $problems;
    }

    private function secretProblem(string $name, int $length): ?string
    {
        $value = $this->value($name);
        if ('' === $value) {
            return \sprintf('%s is not set.', $name);
        }
        if ($this->isDevelopmentValue($name, $value) || 1 === preg_match(self::PLACEHOLDER, $value)) {
            return \sprintf('%s is still a development or example value; generate a new one.', $name);
        }
        if (\strlen($value) < $length) {
            return \sprintf('%s must be at least %d characters.', $name, $length);
        }

        return null;
    }

    /** @return list<string> */
    private function dataKeyProblems(): array
    {
        $keys = $this->value('DATA_KEYS');
        if ('' === $keys) {
            return ['DATA_KEYS is not set.'];
        }
        if ($this->isDevelopmentValue('DATA_KEYS', $keys)) {
            return ['DATA_KEYS is still the development key: mail would be encrypted with a public key.'];
        }
        try {
            new KeyRing($keys, $this->value('DATA_KEY_CURRENT'));
        } catch (CryptoException $exception) {
            return [$exception->getMessage()];
        }

        return [];
    }

    private function isDevelopmentValue(string $name, string $value): bool
    {
        return '' !== $value && \in_array($value, $this->development[$name] ?? [], true);
    }

    private function value(string $name): string
    {
        return trim($this->settings[$name] ?? '');
    }
}
