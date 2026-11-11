<?php

declare(strict_types=1);

namespace App\Controller;

use App\Security\OAuth\AuthorizationServerMetadata;
use App\Security\OAuth\ProtectedResources;
use Symfony\Bundle\FrameworkBundle\Controller\AbstractController;
use Symfony\Component\HttpFoundation\JsonResponse;
use Symfony\Component\HttpFoundation\Request;
use Symfony\Component\Routing\Attribute\Route;

/**
 * The metadata OAuth2 and MCP clients read to find out how to sign in here: the authorization server (RFC 8414) and the
 * resources it protects (RFC 9728), the API and the MCP endpoint. Public, and the same for everyone.
 *
 * There is no `/.well-known/openid-configuration`: this server does not issue ID tokens, and clients fall back to it
 * only when the RFC 8414 document is missing.
 */
final class OAuthMetadataController extends AbstractController
{
    public function __construct(
        private readonly AuthorizationServerMetadata $authorizationServer,
        private readonly ProtectedResources $resources,
    ) {
    }

    #[Route(AuthorizationServerMetadata::PATH, name: 'oauth_authorization_server_metadata', methods: ['GET'])]
    public function authorizationServer(): JsonResponse
    {
        return $this->document($this->authorizationServer->document());
    }

    #[Route(ProtectedResources::METADATA_PATH, name: 'oauth_protected_resource_metadata', methods: ['GET'])]
    public function api(): JsonResponse
    {
        return $this->document($this->resources->metadata($this->resources->apiResource(), 'Tresso API'));
    }

    #[Route(ProtectedResources::METADATA_PATH.ProtectedResources::MCP_PATH, name: 'oauth_protected_resource_metadata_mcp', methods: ['GET'])]
    /** Names the MCP endpoint as the client reached it: on its own host, or on the API host while it answers there. */
    public function mcp(Request $request): JsonResponse
    {
        return $this->document($this->resources->metadata($this->resources->mcpResourceFor($request), 'Tresso MCP'));
    }

    /** @param array<string, mixed> $document */
    private function document(array $document): JsonResponse
    {
        $response = new JsonResponse($document);
        $response->setPublic();
        $response->setMaxAge(3600);

        return $response;
    }
}
