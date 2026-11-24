<?php

declare(strict_types=1);

namespace App\Mcp;

use App\Mcp\Tool\Tool;
use App\Security\OAuth\NarrowedScopes;
use App\Security\Scope;
use Symfony\Component\Security\Core\Authentication\Token\Storage\TokenStorageInterface;
use Symfony\Component\Security\Core\Authorization\AuthorizationCheckerInterface;

/**
 * Which tools the token of the request may use: those whose scopes it holds, checked through the same roles
 * (`ROLE_OAUTH2_<SCOPE>`) the API's own security expressions check. tools/list only shows those, and a call to any
 * other tool is refused before it reaches the API (which would refuse it too).
 */
final readonly class ToolAccess
{
    public function __construct(
        private AuthorizationCheckerInterface $authorizationChecker,
        private TokenStorageInterface $tokenStorage,
    ) {
    }

    public function allows(Tool $tool): bool
    {
        return [] === $this->missingScopes($tool);
    }

    /**
     * @return list<Scope>
     */
    public function missingScopes(Tool $tool): array
    {
        return array_values(array_filter(
            $tool->scopes,
            fn (Scope $scope): bool => !$this->authorizationChecker->isGranted($scope->role()),
        ));
    }

    /**
     * Whether every one of these scopes is one the user granted the app and then switched off in Tresso.
     *
     * @param list<Scope> $scopes
     */
    public function allSwitchedOff(array $scopes): bool
    {
        $off = NarrowedScopes::switchedOff($this->tokenStorage->getToken());

        return [] !== $scopes && [] === array_diff(array_map(static fn (Scope $scope): string => $scope->value, $scopes), $off);
    }
}
