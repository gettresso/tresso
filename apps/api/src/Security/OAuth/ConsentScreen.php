<?php

declare(strict_types=1);

namespace App\Security\OAuth;

use App\Entity\User;
use App\Repository\OAuthConsentRepository;
use App\Security\Scope;
use League\Bundle\OAuth2ServerBundle\Event\AuthorizationRequestResolveEvent;
use League\Bundle\OAuth2ServerBundle\Model\Client;
use League\OAuth2\Server\Exception\OAuthServerException;
use Symfony\Component\HttpFoundation\Request;
use Symfony\Component\HttpFoundation\RequestStack;
use Symfony\Component\HttpFoundation\Response;
use Symfony\Component\Security\Csrf\CsrfToken;
use Symfony\Component\Security\Csrf\CsrfTokenManagerInterface;
use Twig\Environment;

/**
 * Asks the signed-in user whether an app that is not ours may act for them, on /oauth/authorize.
 *
 * The page posts the answer back to the same URL (so the bundle checks the whole authorization request again), with a
 * CSRF token. Allowing records the scopes ({@see Consents}); the next request that asks for no more than those is
 * approved without the page, but only for an app on the web: for an app on the user's own computer (a loopback or an
 * app's own scheme as redirect URI) nothing proves which program asks, since any program there can use a public
 * client id and listen on that port or claim that scheme (RFC 8252 8.6), so the page is shown every time, saying the
 * user allowed the app before. Denying sends the app `access_denied`.
 *
 * The WhatsApp scopes ({@see Scope::chatScopes()}) are listed apart from the others, with a line that they are
 * separate from mail, each as a box the user ticks; Allow grants the other scopes and the ticked ones only.
 *
 * Before anything is shown, the request must only ask for scopes such an app may have, and a `resource` (RFC 8707)
 * must be one this server protects; anything else goes back to the app as `invalid_scope` or `invalid_target`.
 * Tokens are not bound to a resource: the API and the MCP endpoint are one resource server.
 */
final readonly class ConsentScreen
{
    public const string CSRF_TOKEN_ID = 'oauth_consent';
    public const string ALLOW = 'allow';
    public const string DENY = 'deny';

    public function __construct(
        private RequestStack $requests,
        private OAuthConsentRepository $consentRepository,
        private Consents $consents,
        private CsrfTokenManagerInterface $csrfTokens,
        private Environment $twig,
        private ProtectedResources $resources,
    ) {
    }

    /**
     * @throws OAuthServerException when the request asks for what an app that is not ours cannot have
     */
    public function resolve(AuthorizationRequestResolveEvent $event): void
    {
        $request = $this->requests->getCurrentRequest() ?? throw new \LogicException('The consent screen needs a request.');
        $user = $event->getUser();
        if (!$user instanceof User) {
            throw new \LogicException(\sprintf('The consent screen needs a %s, got %s.', User::class, get_debug_type($user)));
        }
        $client = $event->getClient();
        if (!$client instanceof Client) {
            throw new \LogicException(\sprintf('The consent screen needs a %s, got %s.', Client::class, get_debug_type($client)));
        }
        $scopes = array_values(array_unique(array_map(strval(...), $event->getScopes())));
        $this->checkScopes($event, $client, $scopes);
        $this->checkResource($event, $client, $request);

        $consent = $this->consentRepository->findOneFor($user, $client->getIdentifier());
        $allowedBefore = null !== $consent && $consent->covers($scopes);
        if ($allowedBefore && !AppAddress::of(self::targetOf($event, $client))->onThisComputer) {
            $event->resolveAuthorization(AuthorizationRequestResolveEvent::AUTHORIZATION_APPROVED);

            return;
        }

        if (!$request->isMethod('POST')) {
            $event->setResponse($this->page($event, $client, $user, $scopes, $allowedBefore));

            return;
        }

        $token = new CsrfToken(self::CSRF_TOKEN_ID, $request->request->getString('_csrf_token'));
        if (!$this->csrfTokens->isTokenValid($token)) {
            $event->setResponse($this->page($event, $client, $user, $scopes, $allowedBefore, 'This page was open too long or came from somewhere else. Check the request and answer again.'));

            return;
        }

        match ($request->request->getString('decision')) {
            self::ALLOW => $this->allow($event, $user, $client, $scopes, $this->tickedChatScopes($request)),
            self::DENY => $event->resolveAuthorization(AuthorizationRequestResolveEvent::AUTHORIZATION_DENIED),
            default => $event->setResponse($this->page($event, $client, $user, $scopes, $allowedBefore, 'Choose Allow or Deny.')),
        };
    }

    /**
     * Allows what was asked, except the chat scopes the user did not tick: those are withdrawn, also when the app held
     * them before. Nothing to allow at all (a request for chat scopes only, none ticked) is a denial.
     *
     * The authorization code still names every scope asked for (the bundle cannot narrow it here); the token issued for
     * it gets only what the consent holds ({@see TokensNeedConsent}).
     *
     * @param list<string> $scopes
     * @param list<string> $ticked
     */
    private function allow(AuthorizationRequestResolveEvent $event, User $user, Client $client, array $scopes, array $ticked): void
    {
        $granted = array_values(array_filter($scopes, static fn (string $scope): bool => !Scope::from($scope)->isChat() || \in_array($scope, $ticked, true)));
        $withdrawn = array_values(array_diff($scopes, $granted));
        // One answer per page: a second post of the same page needs a new token.
        $this->csrfTokens->refreshToken(self::CSRF_TOKEN_ID);
        if ([] === $granted) {
            $event->resolveAuthorization(AuthorizationRequestResolveEvent::AUTHORIZATION_DENIED);

            return;
        }
        $this->consents->allow($user, $client, $granted, $withdrawn);

        $event->resolveAuthorization(AuthorizationRequestResolveEvent::AUTHORIZATION_APPROVED);
    }

    /**
     * The chat scopes ticked on the page. The boxes are never ticked beforehand, not even for an app allowed them before.
     *
     * @return list<string>
     */
    private function tickedChatScopes(Request $request): array
    {
        $ticked = $request->request->all()['chat_scopes'] ?? [];

        return \is_array($ticked) ? array_values(array_filter($ticked, \is_string(...))) : [];
    }

    /**
     * @param list<string> $scopes
     */
    private function checkScopes(AuthorizationRequestResolveEvent $event, Client $client, array $scopes): void
    {
        // A client stored without scopes may ask for what an app that names no scopes is offered, no more: never the
        // chat scopes, which an app gets only by naming them when it registers.
        $registered = array_map(strval(...), $client->getScopes());
        if ([] === $registered) {
            $registered = ThirdPartyClients::defaultScopeValues();
        }
        foreach ($scopes as $scope) {
            if (!ThirdPartyClients::mayAskFor($scope) || !\in_array($scope, $registered, true)) {
                throw OAuthServerException::invalidScope($scope, $this->redirectUri($event, $client));
            }
        }
    }

    private function checkResource(AuthorizationRequestResolveEvent $event, Client $client, Request $request): void
    {
        if (!$request->query->has('resource')) {
            return;
        }
        $resource = $request->query->all()['resource'];
        if (\is_string($resource) && $this->resources->isKnown($resource)) {
            return;
        }

        throw new OAuthServerException('The requested resource is not one this server protects.', 0, 'invalid_target', 400, \sprintf('Use %s.', implode(' or ', [$this->resources->apiResource(), ...$this->resources->mcpResources()])), $this->redirectUri($event, $client));
    }

    /** Where errors go: the redirect URI of the request, with its state, as the bundle does for its own errors. */
    private function redirectUri(AuthorizationRequestResolveEvent $event, Client $client): string
    {
        $uri = self::targetOf($event, $client);
        $state = $event->getState();
        if (null === $state) {
            return $uri;
        }

        return $uri.(str_contains($uri, '?') ? '&' : '?').http_build_query(['state' => $state]);
    }

    /** The redirect URI the browser goes to: the one in the request, or else the client's only one (as the bundle does). */
    private static function targetOf(AuthorizationRequestResolveEvent $event, Client $client): string
    {
        $uri = $event->getRedirectUri() ?? ($client->getRedirectUris()[0] ?? null);
        if (null === $uri) {
            throw new \LogicException('An authorization request always has a redirect URI.');
        }

        return (string) $uri;
    }

    /**
     * @param list<string> $scopes
     */
    private function page(AuthorizationRequestResolveEvent $event, Client $client, User $user, array $scopes, bool $allowedBefore, ?string $error = null): Response
    {
        $redirectUri = self::targetOf($event, $client);
        $request = $this->requests->getCurrentRequest() ?? throw new \LogicException('The consent screen needs a request.');
        $asked = array_map(static fn (string $scope): Scope => Scope::from($scope), $scopes);

        $response = new Response($this->twig->render('security/consent.html.twig', [
            'app_name' => $client->getName(),
            'address' => AppAddress::of($redirectUri),
            'scopes' => array_values(array_filter($asked, static fn (Scope $scope): bool => !$scope->isChat())),
            'chat_scopes' => array_values(array_filter($asked, static fn (Scope $scope): bool => $scope->isChat())),
            'email' => $user->getEmail(),
            'action' => $request->getRequestUri(),
            'error' => $error,
            'allowed_before' => $allowedBefore,
            'csrf_token_id' => self::CSRF_TOKEN_ID,
        ]), null === $error ? Response::HTTP_OK : Response::HTTP_BAD_REQUEST);

        // Never inside someone else's page (clickjacking), never cached.
        $response->headers->set('X-Frame-Options', 'DENY');
        $response->headers->set('Content-Security-Policy', "frame-ancestors 'none'");
        $response->headers->set('Cache-Control', 'no-store, private');
        $response->headers->set('Referrer-Policy', 'no-referrer');

        return $response;
    }
}
