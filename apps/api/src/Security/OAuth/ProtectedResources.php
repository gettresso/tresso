<?php

declare(strict_types=1);

namespace App\Security\OAuth;

use App\Deployment\PublicAddresses;
use Symfony\Component\HttpFoundation\Request;

/**
 * The resources this server protects with its OAuth2 access tokens, and where each one's metadata (RFC 9728) is: the
 * API itself and the MCP endpoint. This server is their authorization server, whose issuer is API_PUBLIC_URL.
 *
 * The MCP endpoint lives at MCP_PUBLIC_URL (the API address unless it has a host of its own). While it also answers on
 * the API host (MCP_ON_API_HOST), it is known under both addresses: an MCP client checks that the metadata names the
 * URL it connected to (RFC 9728 3.3), so the metadata and the 401 challenge follow the host the request came to
 * ({@see mcpResourceFor()}), and an authorization request may name either as its `resource`.
 *
 * The MCP endpoint answers a request without a valid token with a 401 and {@see mcpChallengeFor()} as its
 * `WWW-Authenticate` header, so an MCP client finds the metadata, and from there this authorization server.
 */
final readonly class ProtectedResources
{
    public const string METADATA_PATH = '/.well-known/oauth-protected-resource';
    public const string MCP_PATH = '/mcp';

    public function __construct(private PublicAddresses $addresses)
    {
    }

    /** The issuer of the authorization server, and the resource identifier of the API. */
    public function issuer(): string
    {
        return $this->addresses->api();
    }

    public function apiResource(): string
    {
        return $this->addresses->api();
    }

    public function apiMetadataUrl(): string
    {
        return $this->addresses->api().self::METADATA_PATH;
    }

    /** The MCP endpoint at its own address. */
    public function mcpResource(): string
    {
        return $this->addresses->mcp().self::MCP_PATH;
    }

    /** The MCP endpoint as a request reached it: on the API host while it still answers there, else at its address. */
    public function mcpResourceFor(Request $request): string
    {
        return $this->mcpBaseFor($request).self::MCP_PATH;
    }

    /** RFC 9728 3.1: the metadata of a resource with a path sits at the well-known path followed by that path. */
    public function mcpMetadataUrlFor(Request $request): string
    {
        return $this->mcpBaseFor($request).self::METADATA_PATH.self::MCP_PATH;
    }

    /** The `WWW-Authenticate` header for a request to the MCP endpoint without a valid token (RFC 9728 5.1). */
    public function mcpChallengeFor(Request $request): string
    {
        return \sprintf('Bearer resource_metadata="%s"', $this->mcpMetadataUrlFor($request));
    }

    /**
     * Every identifier the MCP endpoint goes by: its own address, and the one on the API host while it answers there.
     *
     * @return list<string>
     */
    public function mcpResources(): array
    {
        return array_values(array_unique([
            $this->mcpResource(),
            ...($this->addresses->mcpOnApiHost() ? [$this->addresses->api().self::MCP_PATH] : []),
        ]));
    }

    /**
     * Whether a `resource` parameter (RFC 8707) names one of these resources. A trailing slash is ignored; anything
     * else must match exactly.
     */
    public function isKnown(string $resource): bool
    {
        $resource = rtrim($resource, '/');

        return \in_array($resource, [$this->apiResource(), ...$this->mcpResources()], true);
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

    private function mcpBaseFor(Request $request): string
    {
        if ($this->addresses->mcpHasItsOwnHost() && $this->addresses->mcpOnApiHost() && $this->addresses->isApiHost($request)) {
            return $this->addresses->api();
        }

        return $this->addresses->mcp();
    }
}
