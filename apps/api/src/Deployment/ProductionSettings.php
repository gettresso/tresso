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
        'STRIPE_SECRET_KEY',
        'STRIPE_WEBHOOK_SECRET',
        'GOOGLE_OAUTH_CLIENT_SECRET',
        'MICROSOFT_OAUTH_CLIENT_SECRET',
        'WEB_PUSH_PRIVATE_KEY',
        'EXPO_ACCESS_TOKEN',
    ];

    /** Addresses that must be a bare origin: links, OAuth redirects and the realtime hub are built on them. */
    public const array ORIGINS = ['WEB_APP_URL', 'API_PUBLIC_URL'];

    /** The desktop app's own origins (WebKit on macOS and Linux, WebView2 on Windows). */
    public const array DESKTOP_ORIGINS = ['tauri://localhost', 'http://tauri.localhost'];

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

        $problems = [...$problems, ...$this->dataKeyProblems(), ...$this->originProblems(), ...$this->billingProblems()];

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

    /**
     * Billing, when it is on (Tresso Cloud): Stripe keys of the right kind and a price to sell. Test-mode keys are
     * allowed, for a staging server.
     *
     * @return list<string>
     */
    private function billingProblems(): array
    {
        if (!self::isOn($this->value('TRESSO_BILLING'))) {
            return [];
        }

        $problems = [];
        if (1 !== preg_match('/^(sk|rk)_(live|test)_[A-Za-z0-9]+$/', $this->value('STRIPE_SECRET_KEY'))) {
            $problems[] = 'STRIPE_SECRET_KEY must be a Stripe secret or restricted key (sk_live_, sk_test_, rk_live_ or rk_test_).';
        }
        if (1 !== preg_match('/^whsec_[A-Za-z0-9]+$/', $this->value('STRIPE_WEBHOOK_SECRET'))) {
            $problems[] = 'STRIPE_WEBHOOK_SECRET must be the signing secret (whsec_) of the webhook endpoint.';
        }
        $prices = array_filter([$this->value('STRIPE_PRICE_MONTHLY'), $this->value('STRIPE_PRICE_YEARLY')], static fn (string $price): bool => '' !== $price);
        if ([] === $prices) {
            $problems[] = 'Billing needs STRIPE_PRICE_MONTHLY, STRIPE_PRICE_YEARLY or both.';
        }
        foreach ($prices as $price) {
            if (1 !== preg_match('/^price_[A-Za-z0-9]+$/', $price)) {
                $problems[] = 'STRIPE_PRICE_MONTHLY and STRIPE_PRICE_YEARLY must be Stripe price ids (price_).';
                break;
            }
        }

        return $problems;
    }

    /** Read as Symfony's bool: processor reads it, so the check and the server agree on whether billing is on. */
    private static function isOn(string $value): bool
    {
        return (bool) (filter_var($value, \FILTER_VALIDATE_BOOL) ?: filter_var($value, \FILTER_VALIDATE_INT) ?: filter_var($value, \FILTER_VALIDATE_FLOAT));
    }

    /** @return list<string> */
    private function originProblems(): array
    {
        $problems = [];
        foreach (self::ORIGINS as $name) {
            if (!self::isOrigin($this->value($name))) {
                $problems[] = \sprintf('%s must be an https address as a browser writes it (lower case, no path, trailing slash or :443), such as https://mail.example.com.', $name);
            }
        }

        $cors = $this->value('CORS_ALLOW_ORIGIN');
        if (str_starts_with($cors, '^')) {
            $problems[] = 'CORS_ALLOW_ORIGIN must list origins separated by spaces, not a regular expression.';
        } else {
            $origins = CorsOrigins::origins($cors);
            foreach ($origins as $origin) {
                if (!\in_array($origin, self::DESKTOP_ORIGINS, true) && !self::isOrigin($origin)) {
                    $problems[] = \sprintf('CORS_ALLOW_ORIGIN lists "%s", which is not an https origin as a browser writes it, such as https://mail.example.com.', $origin);
                }
            }
            $web = $this->value('WEB_APP_URL');
            if (self::isOrigin($web) && !\in_array($web, $origins, true)) {
                $problems[] = 'CORS_ALLOW_ORIGIN does not list WEB_APP_URL, so the web client cannot call the API.';
            }
        }

        return $problems;
    }

    /**
     * An https origin spelled the way a browser sends it in Origin, since the API and the realtime hub compare it with
     * that: a lower-case host name (letters, digits, dots and hyphens; an international name in its xn-- form) and at
     * most a port, without a leading zero and never the default 443.
     */
    private static function isOrigin(string $value): bool
    {
        if (1 !== preg_match('{^https://[a-z0-9]([a-z0-9-]*[a-z0-9])?(\.[a-z0-9]([a-z0-9-]*[a-z0-9])?)*(:[1-9][0-9]{0,4})?\z}', $value)) {
            return false;
        }
        // false for a port above 65535.
        $port = parse_url($value, \PHP_URL_PORT);

        return null === $port || (\is_int($port) && 443 !== $port);
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
