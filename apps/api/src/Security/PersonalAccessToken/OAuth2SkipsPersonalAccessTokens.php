<?php

declare(strict_types=1);

namespace App\Security\PersonalAccessToken;

use Symfony\Component\HttpFoundation\Request;
use Symfony\Component\HttpFoundation\Response;
use Symfony\Component\Security\Core\Authentication\Token\TokenInterface;
use Symfony\Component\Security\Core\Exception\AuthenticationException;
use Symfony\Component\Security\Http\Authenticator\AuthenticatorInterface;
use Symfony\Component\Security\Http\Authenticator\Passport\Passport;
use Symfony\Component\Security\Http\EntryPoint\AuthenticationEntryPointInterface;

/**
 * Wraps the OAuth2 authenticator of a firewall so it leaves personal access tokens alone. The bundle's authenticator
 * takes every bearer token; Symfony runs every authenticator that supports a request, so without this the OAuth2 one
 * would reject a personal access token after {@see PersonalAccessTokenAuthenticator} had accepted it. Applied to every
 * firewall with `oauth2: true` by {@see OAuth2SkipsPersonalAccessTokensPass}.
 */
final readonly class OAuth2SkipsPersonalAccessTokens implements AuthenticatorInterface, AuthenticationEntryPointInterface
{
    public function __construct(private AuthenticatorInterface&AuthenticationEntryPointInterface $inner)
    {
    }

    public function supports(Request $request): ?bool
    {
        if (null !== PersonalAccessTokenAuthenticator::secretFrom($request)) {
            return false;
        }

        return $this->inner->supports($request);
    }

    public function authenticate(Request $request): Passport
    {
        return $this->inner->authenticate($request);
    }

    public function createToken(Passport $passport, string $firewallName): TokenInterface
    {
        return $this->inner->createToken($passport, $firewallName);
    }

    public function onAuthenticationSuccess(Request $request, TokenInterface $token, string $firewallName): ?Response
    {
        return $this->inner->onAuthenticationSuccess($request, $token, $firewallName);
    }

    public function onAuthenticationFailure(Request $request, AuthenticationException $exception): ?Response
    {
        return $this->inner->onAuthenticationFailure($request, $exception);
    }

    public function start(Request $request, ?AuthenticationException $authException = null): Response
    {
        return $this->inner->start($request, $authException);
    }
}
