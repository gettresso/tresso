<?php

declare(strict_types=1);

namespace App\Mcp\Security;

use App\Security\OAuth\ProtectedResources;
use Symfony\Bundle\SecurityBundle\Security;
use Symfony\Component\EventDispatcher\Attribute\AsEventListener;
use Symfony\Component\HttpFoundation\Response;
use Symfony\Component\HttpKernel\Event\ResponseEvent;

/**
 * Points every 401 of the MCP endpoint to its protected resource metadata (RFC 9728 5.1), so an MCP client that has no
 * token, or one that stopped working, finds this authorization server and signs in by itself:
 * `WWW-Authenticate: Bearer resource_metadata="<MCP_PUBLIC_URL>/.well-known/oauth-protected-resource/mcp"` (on the API
 * host, while /mcp still answers there, the API address instead), with `error="invalid_token"` (RFC 6750 3.1) when the
 * request carried a bearer token that was refused.
 *
 * The firewall answers those 401s (its entry point when there is no token, the authenticator when the token is
 * refused), each with a bare `Bearer` challenge; this replaces the header on the way out.
 */
#[AsEventListener]
final readonly class McpAuthenticationChallenge
{
    public const string FIREWALL = 'mcp';

    public function __construct(
        private ProtectedResources $protectedResources,
        private Security $security,
    ) {
    }

    public function __invoke(ResponseEvent $event): void
    {
        if (!$event->isMainRequest() || Response::HTTP_UNAUTHORIZED !== $event->getResponse()->getStatusCode()) {
            return;
        }

        $request = $event->getRequest();
        if (self::FIREWALL !== $this->security->getFirewallConfig($request)?->getName()) {
            return;
        }

        $challenge = $this->protectedResources->mcpChallengeFor($request);
        if (str_starts_with((string) $request->headers->get('Authorization', ''), 'Bearer ')) {
            $challenge .= ', error="invalid_token", error_description="The access token is unknown, revoked or expired."';
        }

        $event->getResponse()->headers->set('WWW-Authenticate', $challenge);
    }
}
