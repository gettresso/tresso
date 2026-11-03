<?php

declare(strict_types=1);

namespace App\Security\OAuth;

use App\Entity\RegisteredClient;
use Doctrine\ORM\EntityManagerInterface;
use League\Bundle\OAuth2ServerBundle\Manager\ClientManagerInterface;
use League\Bundle\OAuth2ServerBundle\Model\Client;
use League\Bundle\OAuth2ServerBundle\ValueObject\Grant;
use League\Bundle\OAuth2ServerBundle\ValueObject\RedirectUri;
use League\Bundle\OAuth2ServerBundle\ValueObject\Scope as OAuthScope;
use Psr\Clock\ClockInterface;

/**
 * Dynamic client registration (RFC 7591): makes a public OAuth2 client for an app that is not ours. It has no secret,
 * may not use plain PKCE, and can only use the grants and scopes it registered with.
 */
final readonly class ClientRegistration
{
    public const string ROUTE = 'oauth_register';

    public function __construct(
        private ClientManagerInterface $clients,
        private EntityManagerInterface $entityManager,
        private ClockInterface $clock,
    ) {
    }

    /**
     * @throws ClientRegistrationRefused when a redirect URI is not one the OAuth2 server can hold
     */
    public function register(ClientRegistrationRequest $request): RegisteredClient
    {
        $redirectUris = [];
        foreach ($request->redirectUris as $uri) {
            try {
                $redirectUris[] = new RedirectUri($uri);
            } catch (\RuntimeException) {
                throw ClientRegistrationRefused::redirectUri(\sprintf('"%s" is not a valid URI.', $uri));
            }
        }

        $client = new Client($request->clientName, bin2hex(random_bytes(16)), null);
        $client->setActive(true);
        $client->setAllowPlainTextPkce(false);
        $grants = [];
        foreach ($request->grantTypes as $grant) {
            $grants[] = new Grant($grant);
        }
        $scopes = [];
        foreach ($request->scopes as $scope) {
            $scopes[] = new OAuthScope($scope);
        }
        $client->setGrants(...$grants);
        $client->setRedirectUris(...$redirectUris);
        $client->setScopes(...$scopes);

        $registered = new RegisteredClient($client, $this->clock->now());
        $this->entityManager->wrapInTransaction(function () use ($client, $registered): void {
            $this->clients->save($client);
            $this->entityManager->persist($registered);
            $this->entityManager->flush();
        });

        return $registered;
    }
}
