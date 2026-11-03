<?php

declare(strict_types=1);

namespace App\Security\PersonalAccessToken;

use League\Bundle\OAuth2ServerBundle\Security\Exception\OAuth2AuthenticationException;
use League\Bundle\OAuth2ServerBundle\Security\Exception\OAuth2AuthenticationFailedException;
use League\Bundle\OAuth2ServerBundle\Security\Passport\Badge\ScopeBadge;
use Symfony\Component\HttpFoundation\Request;
use Symfony\Component\HttpFoundation\Response;
use Symfony\Component\Security\Core\Authentication\Token\TokenInterface;
use Symfony\Component\Security\Core\Exception\AuthenticationException;
use Symfony\Component\Security\Http\Authenticator\AuthenticatorInterface;
use Symfony\Component\Security\Http\Authenticator\Passport\Badge\UserBadge;
use Symfony\Component\Security\Http\Authenticator\Passport\Passport;
use Symfony\Component\Security\Http\Authenticator\Passport\SelfValidatingPassport;

/**
 * Signs in requests that carry `Authorization: Bearer tresso_pat_...`. Other bearer tokens are left to the OAuth2
 * authenticator, which in turn skips these ({@see OAuth2SkipsPersonalAccessTokens}). Works on any stateless firewall
 * that lists it under `custom_authenticators`.
 *
 * An unknown, revoked or expired token is refused exactly like a rejected OAuth2 access token: 401, the same body and
 * `WWW-Authenticate: Bearer`, so the response does not tell which of the three it was.
 */
final readonly class PersonalAccessTokenAuthenticator implements AuthenticatorInterface
{
    private const string BEARER = 'Bearer ';

    public function __construct(private PersonalAccessTokens $tokens)
    {
    }

    public static function presentsPersonalAccessToken(Request $request): bool
    {
        $header = (string) $request->headers->get('Authorization', '');

        return str_starts_with($header, self::BEARER) && PersonalAccessTokens::looksLikeSecret(substr($header, \strlen(self::BEARER)));
    }

    public function supports(Request $request): bool
    {
        return self::presentsPersonalAccessToken($request);
    }

    public function authenticate(Request $request): Passport
    {
        $secret = trim(substr((string) $request->headers->get('Authorization', ''), \strlen(self::BEARER)));
        $token = $this->tokens->findUsable($secret);
        if (null === $token) {
            throw OAuth2AuthenticationFailedException::create('The resource server rejected the request.');
        }

        $this->tokens->recordUse($token);
        $owner = $token->getOwner();

        $passport = new SelfValidatingPassport(
            new UserBadge($owner->getUserIdentifier(), static fn () => $owner),
            [new ScopeBadge($token->getScopes())],
        );
        $passport->setAttribute('personalAccessTokenId', $token->getId()->toRfc4122());

        return $passport;
    }

    public function createToken(Passport $passport, string $firewallName): TokenInterface
    {
        /** @var string $id */
        $id = $passport->getAttribute('personalAccessTokenId');
        $scopeBadge = $passport->getBadge(ScopeBadge::class);
        if (!$scopeBadge instanceof ScopeBadge) {
            throw new \LogicException('A personal access token passport carries its scopes.');
        }

        return new PersonalAccessTokenAuthentication($passport->getUser(), $id, $scopeBadge->getScopes());
    }

    public function onAuthenticationSuccess(Request $request, TokenInterface $token, string $firewallName): ?Response
    {
        return null;
    }

    public function onAuthenticationFailure(Request $request, AuthenticationException $exception): Response
    {
        if ($exception instanceof OAuth2AuthenticationException) {
            return new Response($exception->getMessage(), $exception->getStatusCode(), $exception->getHeaders());
        }

        throw $exception;
    }
}
