<?php

declare(strict_types=1);

namespace App\Security\PersonalAccessToken;

use Symfony\Component\DependencyInjection\Compiler\CompilerPassInterface;
use Symfony\Component\DependencyInjection\ContainerBuilder;
use Symfony\Component\DependencyInjection\Definition;
use Symfony\Component\DependencyInjection\Reference;

/**
 * Decorates the OAuth2 authenticator of every firewall (`security.authenticator.oauth2.<firewall>`) with
 * {@see OAuth2SkipsPersonalAccessTokens}, so a firewall added later (such as one for MCP) gets it too.
 */
final class OAuth2SkipsPersonalAccessTokensPass implements CompilerPassInterface
{
    private const string AUTHENTICATOR_PREFIX = 'security.authenticator.oauth2.';

    public function process(ContainerBuilder $container): void
    {
        foreach (array_keys($container->getDefinitions()) as $id) {
            if (!str_starts_with($id, self::AUTHENTICATOR_PREFIX)) {
                continue;
            }

            $container->setDefinition($id.'.skips_personal_access_tokens', new Definition(OAuth2SkipsPersonalAccessTokens::class))
                ->setDecoratedService($id)
                ->setArguments([new Reference('.inner')]);
        }
    }
}
