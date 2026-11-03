<?php

declare(strict_types=1);

namespace App\Security\PersonalAccessToken;

use App\Entity\PersonalAccessToken;
use App\Entity\User;
use App\Repository\PersonalAccessTokenRepository;
use App\Security\Scope;
use Doctrine\DBAL\Connection;
use Doctrine\ORM\EntityManagerInterface;
use Psr\Clock\ClockInterface;

/**
 * Makes personal access tokens and finds the one a request presents. A secret is `tresso_pat_` followed by 32 random
 * bytes in base64url; only its SHA-256 is stored, and it is handed out once, by {@see issue()}.
 */
final readonly class PersonalAccessTokens
{
    public const string SECRET_PREFIX = 'tresso_pat_';

    /** How many days a new token may last; the API offers only these. */
    public const array LIFETIMES_IN_DAYS = [30, 90, 365];
    public const int DEFAULT_LIFETIME_IN_DAYS = 90;

    /** Characters of the random part kept in the prefix the user sees. */
    private const int VISIBLE_RANDOM_CHARACTERS = 6;

    /** Writing the last use on every request would be a write per request; once a minute is precise enough. */
    private const string LAST_USED_PRECISION = 'PT1M';

    public function __construct(
        private PersonalAccessTokenRepository $tokens,
        private EntityManagerInterface $entityManager,
        private Connection $connection,
        private ClockInterface $clock,
    ) {
    }

    public static function looksLikeSecret(string $bearer): bool
    {
        return str_starts_with($bearer, self::SECRET_PREFIX);
    }

    public static function hash(#[\SensitiveParameter] string $secret): string
    {
        return hash('sha256', $secret);
    }

    /**
     * Makes and stores a token. The caller flushes; the secret in the result is the only copy there will ever be.
     *
     * @param list<Scope> $scopes
     */
    public function issue(User $owner, string $name, array $scopes, int $lifetimeInDays): IssuedPersonalAccessToken
    {
        if (!\in_array($lifetimeInDays, self::LIFETIMES_IN_DAYS, true)) {
            throw new \InvalidArgumentException(\sprintf('A personal access token lasts %s days, not %d.', implode(', ', self::LIFETIMES_IN_DAYS), $lifetimeInDays));
        }

        $random = rtrim(strtr(base64_encode(random_bytes(32)), '+/', '-_'), '=');
        $secret = self::SECRET_PREFIX.$random;
        $now = $this->clock->now();

        $token = new PersonalAccessToken(
            $owner,
            $name,
            self::hash($secret),
            self::SECRET_PREFIX.substr($random, 0, self::VISIBLE_RANDOM_CHARACTERS),
            $scopes,
            $now,
            $now->modify(\sprintf('+%d days', $lifetimeInDays)),
        );
        $this->entityManager->persist($token);

        return new IssuedPersonalAccessToken($token, $secret);
    }

    /**
     * The token behind a secret, when it exists, is not revoked and has not expired.
     */
    public function findUsable(#[\SensitiveParameter] string $secret): ?PersonalAccessToken
    {
        if (!self::looksLikeSecret($secret)) {
            return null;
        }

        $token = $this->tokens->findOneByTokenHash(self::hash($secret));

        return null !== $token && $token->isUsableAt($this->clock->now()) ? $token : null;
    }

    /**
     * Records that the token was used, at most once a minute per token. Written in SQL, so it never flushes whatever
     * else the request has pending; the condition keeps concurrent requests from writing more than once.
     */
    public function recordUse(PersonalAccessToken $token): void
    {
        $now = $this->clock->now();
        $threshold = $now->sub(new \DateInterval(self::LAST_USED_PRECISION));
        $lastUsedAt = $token->getLastUsedAt();
        if (null !== $lastUsedAt && $lastUsedAt > $threshold) {
            return;
        }

        $this->connection->executeStatement(
            'UPDATE personal_access_token SET last_used_at = :now WHERE id = :id AND (last_used_at IS NULL OR last_used_at <= :threshold)',
            ['now' => $now->format('Y-m-d H:i:s'), 'id' => $token->getId()->toRfc4122(), 'threshold' => $threshold->format('Y-m-d H:i:s')],
        );
    }
}
