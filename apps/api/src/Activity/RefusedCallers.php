<?php

declare(strict_types=1);

namespace App\Activity;

use App\Security\PersonalAccessToken\PersonalAccessTokenAuthenticator;
use App\Security\PersonalAccessToken\PersonalAccessTokens;
use Doctrine\DBAL\Connection;
use Psr\Clock\ClockInterface;
use Symfony\Component\HttpFoundation\Request;
use Symfony\Component\Uid\Uuid;

/**
 * Who sent a request the firewall refused (401), when that is known for sure and worth telling the user:
 * - a personal access token that expired (Token expired) or was revoked (Access revoked), found by the hash of its
 *   secret as it is stored;
 * - an access token of an app the user disconnected (Access revoked): the token's id (`jti`, 80 random hex characters,
 *   known only to whoever holds the token) names a stored token that was revoked, and the user no longer allows the
 *   app.
 *
 * Anything else stays unidentified and is not logged: no token, an unknown or forged one, one of our own apps, and an
 * app's access token that simply expired or was replaced by a refresh, which a client renews by itself every hour and
 * which would only fill the log with refusals that are none.
 */
final readonly class RefusedCallers
{
    private const string JTI = '/^[a-f0-9]{80}$/';

    public function __construct(
        private Connection $connection,
        private ClockInterface $clock,
    ) {
    }

    /**
     * @return array{owner: Uuid, app: ActivityApp, reason: ActivityReason}|null
     */
    public function identify(Request $request): ?array
    {
        $secret = PersonalAccessTokenAuthenticator::secretFrom($request);
        if (null !== $secret) {
            return $this->personalAccessToken($secret);
        }

        $header = (string) $request->headers->get('Authorization', '');
        if (1 !== preg_match('/^Bearer\s+([A-Za-z0-9_-]+)\.([A-Za-z0-9_-]+)\.[A-Za-z0-9_-]+$/', $header, $parts)) {
            return null;
        }

        return $this->accessToken($parts[2]);
    }

    /**
     * @return array{owner: Uuid, app: ActivityApp, reason: ActivityReason}|null
     */
    private function personalAccessToken(#[\SensitiveParameter] string $secret): ?array
    {
        $row = $this->connection->fetchAssociative(
            'SELECT id, owner_id, expires_at, revoked_at FROM personal_access_token WHERE token_hash = :hash',
            ['hash' => PersonalAccessTokens::hash($secret)],
        );
        if (false === $row) {
            return null;
        }

        $reason = match (true) {
            null !== $row['revoked_at'] => ActivityReason::AccessRevoked,
            new \DateTimeImmutable(self::text($row['expires_at'])) <= $this->clock->now() => ActivityReason::TokenExpired,
            default => null,
        };

        return null === $reason ? null : [
            'owner' => Uuid::fromString(self::text($row['owner_id'])),
            'app' => ActivityApp::token(self::text($row['id'])),
            'reason' => $reason,
        ];
    }

    /**
     * @return array{owner: Uuid, app: ActivityApp, reason: ActivityReason}|null
     */
    private function accessToken(string $payload): ?array
    {
        $claims = json_decode((string) base64_decode(strtr($payload, '-_', '+/'), true), true);
        $jti = \is_array($claims) ? ($claims['jti'] ?? null) : null;
        if (!\is_string($jti) || 1 !== preg_match(self::JTI, $jti)) {
            return null;
        }

        $row = $this->connection->fetchAssociative(
            'SELECT t.client, u.id AS owner_id
               FROM oauth2_access_token t
               JOIN app_user u ON u.email = t.user_identifier
              WHERE t.identifier = :jti AND t.revoked = true
                AND NOT EXISTS (SELECT 1 FROM oauth_consent c WHERE c.user_id = u.id AND c.client_id = t.client)',
            ['jti' => $jti],
        );
        if (false === $row) {
            return null;
        }
        $client = rtrim(self::text($row['client']));
        if (!ActivityApp::isLogged($client)) {
            return null;
        }

        return [
            'owner' => Uuid::fromString(self::text($row['owner_id'])),
            'app' => ActivityApp::client($client),
            'reason' => ActivityReason::AccessRevoked,
        ];
    }

    /** A text column as a string. */
    private static function text(mixed $value): string
    {
        return \is_scalar($value) ? (string) $value : '';
    }
}
