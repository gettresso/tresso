<?php

declare(strict_types=1);

namespace App\Security\OAuth;

use Symfony\Component\DependencyInjection\Attribute\Autowire;

/**
 * The resources this server protects with its OAuth2 access tokens, and where each one's metadata (RFC 9728) is: the
 * API itself and the MCP endpoint. Both are served by this server, which is also their authorization server, so their
 * addresses all start with API_PUBLIC_URL.
 *
 * The MCP endpoint answers a request without a valid token with a 401 and {@see mcpChallenge()} as its
 * `WWW-Authenticate` header, so an MCP client finds the metadata, and from there this authorization server.
 */
final readonly class ProtectedResources
{
    public const string METADATA_PATH = '/.well-known/oauth-protected-resource';
    public const string MCP_PATH = '/mcp';

    private string $baseUrl;

    public function __construct(
        #[Autowire(env: 'API_PUBLIC_URL')]
        string $apiPublicUrl,
    ) {
        $baseUrl = rtrim($apiPublicUrl, '/');
        if ('' === $baseUrl) {
            throw new \InvalidArgumentException('API_PUBLIC_URL is empty.');
        }
        $this->baseUrl = $baseUrl;
    }

    /** The issuer of the authorization server, and the resource identifier of the API. */
    public function issuer(): string
    {
        return $this->baseUrl;
    }

    public function apiResource(): string
    {
        return $this->baseUrl;
    }

    public function apiMetadataUrl(): string
    {
        return $this->baseUrl.self::METADATA_PATH;
    }

    public function mcpResource(): string
    {
        return $this->baseUrl.self::MCP_PATH;
    }

    /** RFC 9728 3.1: the metadata of a resource with a path sits at the well-known path followed by that path. */
    public function mcpMetadataUrl(): string
    {
        return $this->baseUrl.self::METADATA_PATH.self::MCP_PATH;
    }

    /** The `WWW-Authenticate` header for a request to the MCP endpoint without a valid token (RFC 9728 5.1). */
    public function mcpChallenge(): string
    {
        return \sprintf('Bearer resource_metadata="%s"', $this->mcpMetadataUrl());
    }

    /**
     * Whether a `resource` parameter (RFC 8707) names one of these resources. A trailing slash is ignored; anything
     * else must match exactly.
     */
    public function isKnown(string $resource): bool
    {
        $resource = rtrim($resource, '/');

        return \in_array($resource, [$this->apiResource(), $this->mcpResource()], true);
    }

    /**
     * The protected resource metadata (RFC 9728 2) of a resource.
     *
     * @return array<string, mixed>
     */
    public function metadata(string $resource, string $name): array
    {
        return [
            'resource' => $resource,
            'resource_name' => $name,
            'authorization_servers' => [$this->issuer()],
            'scopes_supported' => ThirdPartyClients::scopeValues(),
            'bearer_methods_supported' => ['header'],
        ];
    }
}
