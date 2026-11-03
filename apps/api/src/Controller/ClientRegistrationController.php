<?php

declare(strict_types=1);

namespace App\Controller;

use App\Security\OAuth\ClientRegistration;
use App\Security\OAuth\ClientRegistrationRefused;
use App\Security\OAuth\ClientRegistrationRequest;
use App\Security\OAuth\RedirectUriPolicy;
use Symfony\Bundle\FrameworkBundle\Controller\AbstractController;
use Symfony\Component\DependencyInjection\Attribute\Autowire;
use Symfony\Component\HttpFoundation\Exception\JsonException;
use Symfony\Component\HttpFoundation\JsonResponse;
use Symfony\Component\HttpFoundation\Request;
use Symfony\Component\HttpFoundation\Response;
use Symfony\Component\RateLimiter\RateLimiterFactoryInterface;
use Symfony\Component\Routing\Attribute\Route;

/**
 * Dynamic client registration (RFC 7591) for apps that are not ours, such as MCP clients: open to anyone, limited per
 * IP address. The body is client metadata as RFC 7591 defines it, with its own error format (3.2.2), so it is read as
 * plain JSON rather than mapped onto a DTO: unknown fields must be ignored, and every refusal names an RFC error code.
 */
final class ClientRegistrationController extends AbstractController
{
    public function __construct(
        private readonly ClientRegistration $registration,
        private readonly RedirectUriPolicy $redirectUris,
        #[Autowire(service: 'limiter.oauth_client_registration')]
        private readonly RateLimiterFactoryInterface $limiter,
    ) {
    }

    #[Route('/oauth/register', name: ClientRegistration::ROUTE, methods: ['POST'])]
    public function register(Request $request): JsonResponse
    {
        $limit = $this->limiter->create($request->getClientIp() ?? 'unknown')->consume();
        if (!$limit->isAccepted()) {
            $response = $this->error(Response::HTTP_TOO_MANY_REQUESTS, 'temporarily_unavailable', 'Too many registrations from this address. Try again later.');
            $response->headers->set('Retry-After', (string) max(1, $limit->getRetryAfter()->getTimestamp() - time()));

            return $response;
        }

        try {
            $metadata = $request->toArray();
        } catch (JsonException) {
            return $this->error(Response::HTTP_BAD_REQUEST, ClientRegistrationRefused::INVALID_CLIENT_METADATA, 'The body must be a JSON object with the client metadata.');
        }

        try {
            $registered = $this->registration->register(ClientRegistrationRequest::fromMetadata($metadata, $this->redirectUris));
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
