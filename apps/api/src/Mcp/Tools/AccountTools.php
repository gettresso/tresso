<?php

declare(strict_types=1);

namespace App\Mcp\Tools;

use App\Mcp\Api;
use App\Mcp\Tool\Schema;
use App\Mcp\Tool\Tool;
use App\Mcp\Tool\ToolArguments;
use App\Mcp\Tool\ToolEffect;
use App\Mcp\Tool\ToolProvider;
use App\Security\Scope;
use Symfony\Component\Security\Core\Authorization\AuthorizationCheckerInterface;

/**
 * Who the connection acts for, and what this server is.
 */
final readonly class AccountTools implements ToolProvider
{
    public function __construct(private AuthorizationCheckerInterface $authorizationChecker)
    {
    }

    public function tools(): iterable
    {
        yield new Tool(
            name: 'get_me',
            title: 'Who am I',
            description: 'The Tresso user this connection acts for (id, sign-in address, name), the scopes it was given, '
                .'and, with settings:read, their mail accounts (ids, addresses, names, status and default signature). '
                .'Call this first to learn which tools will work and which mail account ids exist.',
            scopes: [],
            effect: ToolEffect::Read,
            inputSchema: Schema::object(),
            run: $this->me(...),
        );

        yield new Tool(
            name: 'get_server_info',
            title: 'Server information',
            description: 'What this Tresso server is: product, API version and whether it has billing (Tresso Cloud) or '
                .'is self-hosted.',
            scopes: [],
            effect: ToolEffect::Read,
            inputSchema: Schema::object(),
            run: static fn (ToolArguments $arguments, Api $api): array => $api->get('/server-info'),
        );
    }

    /**
     * @return array<mixed>
     */
    private function me(ToolArguments $arguments, Api $api): array
    {
        $me = $api->get('/me');
        $me['scopes'] = array_values(array_map(
            static fn (Scope $scope): string => $scope->value,
            array_filter(Scope::userScopes(), fn (Scope $scope): bool => $this->authorizationChecker->isGranted($scope->role())),
        ));

        if ($this->authorizationChecker->isGranted(Scope::SettingsRead->role())) {
            $me['mailAccounts'] = array_map(MailAccountTools::summary(...), $api->get('/mail-accounts'));
        }

        return $me;
    }
}
