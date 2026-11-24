<?php

declare(strict_types=1);

namespace App\Activity;

use App\Command\BootstrapOAuthClientsCommand;
use App\Security\FirstPartyClients;
use App\Security\Scope;
use App\Security\PersonalAccessToken\PersonalAccessTokenAuthentication;
use League\Bundle\OAuth2ServerBundle\Security\Authentication\Token\OAuth2Token;
use Symfony\Component\Security\Core\Authentication\Token\TokenInterface;
use Symfony\Component\Uid\Uuid;

/**
 * The app an entry of the activity log belongs to, by id only: an OAuth client that is not ours (by its client id) or
 * a personal access token (by its id). Its name is looked up when the log is read. Written as a key, `client:<id>` or
 * `token:<uuid>`, which the log's app filter takes.
 */
final readonly class ActivityApp
{
    public const string CLIENT = 'client';
    public const string TOKEN = 'token';

    private function __construct(
        /** {@see CLIENT} or {@see TOKEN} */
        public string $type,
        public string $id,
    ) {
    }

    public static function client(string $clientIdentifier): self
    {
        return new self(self::CLIENT, $clientIdentifier);
    }

    public static function token(string $personalAccessTokenId): self
    {
        return new self(self::TOKEN, Uuid::fromString($personalAccessTokenId)->toRfc4122());
    }

    /**
     * The app of a request's security token, or null for a caller that is not logged: one of Tresso's own apps, the
     * sync worker, or no token at all.
     */
    public static function of(?TokenInterface $token): ?self
    {
        if ($token instanceof PersonalAccessTokenAuthentication) {
            return self::token($token->getPersonalAccessTokenId());
        }
        if (!$token instanceof OAuth2Token || FirstPartyClients::signedRequest($token)) {
            return null;
        }

        return self::isLogged($token->getOAuthClientId()) ? self::client($token->getOAuthClientId()) : null;
    }

    /** Whether calls of this OAuth client are logged: every client but our own apps and the sync worker. */
    public static function isLogged(string $clientIdentifier): bool
    {
        return !FirstPartyClients::isFirstParty($clientIdentifier) && BootstrapOAuthClientsCommand::SYNC_WORKER !== $clientIdentifier;
    }

    /**
     * Of these scopes, those the security token of the request does not hold: what an app lacked when it was refused.
     *
     * @param list<string> $scopes
     *
     * @return list<string>
     */
    public static function missingScopes(array $scopes, ?TokenInterface $token): array
    {
        $roles = $token?->getRoleNames() ?? [];

        return array_values(array_filter($scopes, static fn (string $scope): bool => !\in_array(Scope::ROLE_PREFIX.strtoupper($scope), $roles, true)));
    }

    /** `client:<id>` or `token:<uuid>`; null for anything else. */
    public static function fromKey(string $key): ?self
    {
        [$type, $id] = array_pad(explode(':', $key, 2), 2, '');
        if ('' === $id) {
            return null;
        }

        return match ($type) {
            self::CLIENT => \strlen($id) <= 80 ? self::client($id) : null,
            self::TOKEN => Uuid::isValid($id) ? self::token($id) : null,
            default => null,
        };
    }

    public function key(): string
    {
        return $this->type.':'.$this->id;
    }
}
