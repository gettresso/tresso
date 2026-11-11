<?php

declare(strict_types=1);

namespace App\Security\OAuth;

use Doctrine\DBAL\ArrayParameterType;
use Doctrine\DBAL\Connection;
use League\Bundle\OAuth2ServerBundle\Manager\ClientManagerInterface;

/**
 * Token revocation (RFC 7009) for public clients: a client that signs out tells the server to forget its tokens.
 *
 * A refresh token takes the access token issued with it along, and an access token the refresh tokens issued with it,
 * so whichever of the two a client sends, the pair is dead. A refresh token that rotated moments ago also takes its
 * successor along ({@see RefreshTokenRotation}): a client signing out with the token whose refresh response it never
 * received still ends everything that refresh issued. Both end the rotation grace at once.
 *
 * Only tokens issued to the client that asks, and only for clients without a secret: a confidential client would
 * have to authenticate first, which this endpoint does not do. Whatever is presented, the caller learns nothing about
 * it (RFC 7009 2.2: an unknown, foreign or already revoked token is answered like any other).
 */
final readonly class TokenRevocation
{
    /** How many rotations in a row are followed; more than one only happens within the grace. */
    private const int MAX_SUCCESSORS = 5;

    public function __construct(
        private IssuedTokens $tokens,
        private RefreshTokenRotation $rotation,
        private ClientManagerInterface $clients,
        private Connection $connection,
    ) {
    }

    /**
     * @param string|null $hint `refresh_token` or `access_token` (RFC 7009 2.1); any other value is no hint
     */
    public function revoke(#[\SensitiveParameter] string $token, ?string $hint, string $clientId): void
    {
        $issued = IssuedToken::ACCESS_TOKEN === $hint
            ? ($this->tokens->accessToken($token) ?? $this->tokens->refreshToken($token))
            : ($this->tokens->refreshToken($token) ?? $this->tokens->accessToken($token));
        if (null === $issued || $issued->clientId !== $clientId || !$this->isPublic($clientId)) {
            return;
        }

        $this->connection->transactional(function () use ($issued): void {
            if (IssuedToken::REFRESH_TOKEN === $issued->type) {
                $this->revokeRefreshTokens([$issued->id]);
            } else {
                $this->revokeRefreshTokens($this->refreshTokensOf($issued->accessTokenId));
            }
            $this->revokeAccessTokens([$issued->accessTokenId]);
        });
    }

    /**
     * Revokes these refresh tokens, the access tokens issued with them, and whatever they rotated into just now.
     *
     * @param list<string> $ids
     */
    private function revokeRefreshTokens(array $ids): void
    {
        $seen = [];
        for ($round = 0; [] !== $ids && $round <= self::MAX_SUCCESSORS; ++$round) {
            $successors = [];
            foreach ($ids as $id) {
                $seen[$id] = true;
                $successor = $this->rotation->successorOf($id);
                if (null !== $successor && !isset($seen[$successor])) {
                    $successors[] = $successor;
                }
            }

            $accessTokens = array_values(array_filter(array_map(
                static fn (mixed $id): ?string => \is_string($id) ? $id : null,
                $this->connection->fetchFirstColumn('SELECT access_token FROM oauth2_refresh_token WHERE identifier IN (:ids)', ['ids' => $ids], ['ids' => ArrayParameterType::STRING]),
            )));
            $this->connection->executeStatement('UPDATE oauth2_refresh_token SET revoked = true WHERE identifier IN (:ids)', ['ids' => $ids], ['ids' => ArrayParameterType::STRING]);
            $this->revokeAccessTokens($accessTokens);
            foreach ($ids as $id) {
                $this->rotation->forget($id, null);
            }

            $ids = $successors;
        }
    }

    /** @param list<string> $ids */
    private function revokeAccessTokens(array $ids): void
    {
        if ([] === $ids) {
            return;
        }
        $this->connection->executeStatement('UPDATE oauth2_access_token SET revoked = true WHERE identifier IN (:ids)', ['ids' => $ids], ['ids' => ArrayParameterType::STRING]);
        foreach ($ids as $id) {
            $this->rotation->forget(null, $id);
        }
    }

    /** @return list<string> */
    private function refreshTokensOf(string $accessTokenId): array
    {
        return array_values(array_filter(array_map(
            static fn (mixed $id): ?string => \is_string($id) ? $id : null,
            $this->connection->fetchFirstColumn('SELECT identifier FROM oauth2_refresh_token WHERE access_token = :id', ['id' => $accessTokenId]),
        )));
    }

    private function isPublic(string $clientId): bool
    {
        $client = $this->clients->find($clientId);

        return null !== $client && \in_array($client->getSecret(), [null, ''], true);
    }
}
