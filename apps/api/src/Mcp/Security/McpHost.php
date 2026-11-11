<?php

declare(strict_types=1);

namespace App\Mcp\Security;

use App\Deployment\PublicAddresses;
use App\Security\OAuth\ProtectedResources;
use Symfony\Component\EventDispatcher\Attribute\AsEventListener;
use Symfony\Component\HttpFoundation\Response;
use Symfony\Component\HttpKernel\Event\RequestEvent;
use Symfony\Component\HttpKernel\KernelEvents;

/**
 * Which host answers what, once the MCP endpoint has a host of its own (MCP_PUBLIC_URL):
 * - the MCP host answers only /mcp and its protected resource metadata, so it is no second API host;
 * - /mcp answers on the API host only while MCP_ON_API_HOST is on (the address older connections were set up with);
 * - /mcp answers on no other host.
 * Anything else is a 404. With MCP_PUBLIC_URL left empty, nothing changes.
 */
#[AsEventListener(event: KernelEvents::REQUEST, priority: self::PRIORITY)]
final readonly class McpHost
{
    public const array PATHS_ON_THE_MCP_HOST = [ProtectedResources::MCP_PATH, ProtectedResources::METADATA_PATH.ProtectedResources::MCP_PATH];

    /** Before the router (32) and everything that depends on the route. */
    private const int PRIORITY = 40;

    public function __construct(private PublicAddresses $addresses)
    {
    }

    public function __invoke(RequestEvent $event): void
    {
        $request = $event->getRequest();
        if (!$event->isMainRequest() || !$this->addresses->mcpHasItsOwnHost()) {
            return;
        }

        $path = $request->getPathInfo();
        $answers = match (true) {
            $this->addresses->isMcpHost($request) => \in_array($path, self::PATHS_ON_THE_MCP_HOST, true),
            ProtectedResources::MCP_PATH !== $path => true,
            default => $this->addresses->mcpOnApiHost() && $this->addresses->isApiHost($request),
        };
        if (!$answers) {
            $event->setResponse(new Response('Not found.', Response::HTTP_NOT_FOUND, ['Content-Type' => 'text/plain; charset=UTF-8']));
        }
    }
}
