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

        $problems = [...$problems, ...$this->dataKeyProblems()];

        $database = $this->value('DATABASE_URL');
        if ('' === $database || 1 === preg_match(self::PLACEHOLDER, $database) || $this->isDevelopmentValue('DATABASE_URL', $database)) {
            $problems[] = 'DATABASE_URL is not set to your database.';
        }

        if (!\in_array($this->value('MAIL_ALLOW_UNSAFE_SERVERS'), ['', '0'], true)) {
            $problems[] = 'MAIL_ALLOW_UNSAFE_SERVERS must be 0: it would let users point the sync workers at internal services.';
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
