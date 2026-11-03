<?php

declare(strict_types=1);

namespace App\Security\OAuth;

use Symfony\Component\Routing\Generator\UrlGeneratorInterface;

/**
 * The authorization server metadata (RFC 8414) that OAuth2 and MCP clients read to find out how to sign in here. It
 * describes what an app that is not ours may do; our own apps are configured with these endpoints and need none of it.
 */
final readonly class AuthorizationServerMetadata
{
    public const string PATH = '/.well-known/oauth-authorization-server';

    public function __construct(
        private ProtectedResources $resources,
        private UrlGeneratorInterface $urls,
    ) {
    }

    /** @return array<string, mixed> */
    public function document(): array
    {
        $issuer = $this->resources->issuer();

        return [
            'issuer' => $issuer,
            'authorization_endpoint' => $issuer.$this->urls->generate('oauth2_authorize'),
            'token_endpoint' => $issuer.$this->urls->generate('oauth2_token'),
            'registration_endpoint' => $issuer.$this->urls->generate(ClientRegistration::ROUTE),
            'scopes_supported' => ThirdPartyClients::scopeValues(),
            'response_types_supported' => ['code'],
            'response_modes_supported' => ['query'],
            'grant_types_supported' => ThirdPartyClients::GRANT_TYPES,
            'code_challenge_methods_supported' => ['S256'],
            'token_endpoint_auth_methods_supported' => ['none'],
        ];
    }
}
