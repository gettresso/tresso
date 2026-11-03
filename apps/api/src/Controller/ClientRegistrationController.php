<?php

declare(strict_types=1);

namespace App\Controller;

use App\Security\OAuth\ClientRegistration;
use App\Security\OAuth\ClientRegistrationRefused;
use App\Security\OAuth\ClientRegistrationRequest;
use App\Security\OAuth\RedirectUriPolicy;
use App\Security\OAuth\TressoLookalikes;
use Symfony\Bundle\FrameworkBundle\Controller\AbstractController;
use Symfony\Component\DependencyInjection\Attribute\Autowire;
use Symfony\Component\HttpFoundation\Exception\JsonException;
use Symfony\Component\HttpFoundation\JsonResponse;
use Symfony\Component\HttpFoundation\Request;
use Symfony\Component\HttpFoundation\Response;
use Symfony\Component\RateLimiter\RateLimiterFactoryInterface;
use Symfony\Component\Routing\Attribute\Route;

/**
 * Dynamic client registration (RFC 7591) for apps that are not ours, such as MCP clients: open to anyone, limited
 * per IPv4 address or IPv6 /64 and in total. The body is client metadata as RFC 7591 defines it, with its own error
 * format (3.2.2), so it is read as plain JSON rather than mapped onto a DTO: unknown fields must be ignored, and every
 * refusal names an RFC error code.
 */
final class ClientRegistrationController extends AbstractController
{
    public function __construct(
        private readonly ClientRegistration $registration,
        private readonly RedirectUriPolicy $redirectUris,
        private readonly TressoLookalikes $tresso,
        #[Autowire(service: 'limiter.oauth_client_registration')]
        private readonly RateLimiterFactoryInterface $limiter,
        #[Autowire(service: 'limiter.oauth_client_registration_global')]
        private readonly RateLimiterFactoryInterface $globalLimiter,
    ) {
    }

    /**
     * What one sender is: an IPv4 address, or the /64 network of an IPv6 address (one network usually gets a whole /64,
     * so counting single IPv6 addresses would limit nothing).
     */
    public static function limitKey(?string $ip): string
    {
        if (null === $ip) {
            return 'unknown';
        }
        $packed = filter_var($ip, \FILTER_VALIDATE_IP, \FILTER_FLAG_IPV6) ? inet_pton($ip) : false;
        if (false === $packed || 16 !== \strlen($packed)) {
            return $ip;
        }
        $network = inet_ntop(substr($packed, 0, 8).str_repeat("\0", 8));

        return (false === $network ? $ip : $network).'/64';
    }

    #[Route('/oauth/register', name: ClientRegistration::ROUTE, methods: ['POST'])]
    public function register(Request $request): JsonResponse
    {
        foreach ([$this->limiter->create(self::limitKey($request->getClientIp())), $this->globalLimiter->create('all')] as $limiter) {
            $limit = $limiter->consume();
            if (!$limit->isAccepted()) {
                $response = $this->error(Response::HTTP_TOO_MANY_REQUESTS, 'temporarily_unavailable', 'Too many registrations. Try again later.');
                $response->headers->set('Retry-After', (string) max(1, $limit->getRetryAfter()->getTimestamp() - time()));

                return $response;
            }
        }

        try {
            $metadata = $request->toArray();
        } catch (JsonException) {
            return $this->error(Response::HTTP_BAD_REQUEST, ClientRegistrationRefused::INVALID_CLIENT_METADATA, 'The body must be a JSON object with the client metadata.');
        }

        try {
            $registered = $this->registration->register(ClientRegistrationRequest::fromMetadata($metadata, $this->redirectUris, $this->tresso));
        } catch (ClientRegistrationRefused $refused) {
            return $this->error(Response::HTTP_BAD_REQUEST, $refused->error, $refused->getMessage());
        }

        $client = $registered->getClient();

        return $this->noStore(new JsonResponse([
            'client_id' => $client->getIdentifier(),
            'client_id_issued_at' => $registered->getCreatedAt()->getTimestamp(),
            'client_name' => $client->getName(),
            'redirect_uris' => array_map(strval(...), $client->getRedirectUris()),
            'grant_types' => array_map(strval(...), $client->getGrants()),
            'response_types' => ['code'],
            'token_endpoint_auth_method' => 'none',
            'scope' => implode(' ', array_map(strval(...), $client->getScopes())),
        ], Response::HTTP_CREATED));
    }

    private function error(int $status, string $error, string $description): JsonResponse
    {
        return $this->noStore(new JsonResponse(['error' => $error, 'error_description' => $description], $status));
    }

    private function noStore(JsonResponse $response): JsonResponse
    {
        $response->headers->set('Cache-Control', 'no-store, private');
        $response->headers->set('Pragma', 'no-cache');

        return $response;
    }
}
