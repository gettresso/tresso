<?php

declare(strict_types=1);

namespace App\State;

use ApiPlatform\Metadata\Operation;
use ApiPlatform\State\ProviderInterface;
use App\ApiResource\RealtimeToken;
use App\Realtime\MercureTokens;
use App\Security\CurrentUser;
use App\Security\PersonalAccessToken\PersonalAccessTokenAuthentication;
use League\Bundle\OAuth2ServerBundle\Security\Authentication\Token\OAuth2Token;
use Symfony\Bundle\SecurityBundle\Security;
use Symfony\Component\Security\Core\Exception\AccessDeniedException;

/**
 * @implements ProviderInterface<RealtimeToken>
 */
final readonly class RealtimeTokenProvider implements ProviderInterface
{
    public function __construct(
        private CurrentUser $currentUser,
        private Security $security,
        private MercureTokens $tokens,
    ) {
    }

    public function provide(Operation $operation, array $uriVariables = [], array $context = []): RealtimeToken
    {
        $user = $this->currentUser->get();
        $authentication = $this->security->getToken();
        if (!$authentication instanceof OAuth2Token) {
            throw new AccessDeniedException('This endpoint requires an OAuth2 access token.');
        }
        // A realtime token outlives a revoked personal access token by up to an hour, and tokens are for scripts and
        // MCP, which fetch the delta instead.
        if ($authentication instanceof PersonalAccessTokenAuthentication) {
            throw new AccessDeniedException('Personal access tokens cannot subscribe to realtime updates.');
        }

        $token = $this->tokens->subscriberToken($user->getId(), $authentication->getOAuthClientId());

        return new RealtimeToken($this->tokens->hubUrl(), MercureTokens::changesTopic($user->getId()), $token->value, $token->expiresAt);
    }
}
