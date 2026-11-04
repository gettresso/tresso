<?php

declare(strict_types=1);

namespace App\Controller;

use App\Enum\OAuthProvider;
use App\ProviderAuth\ProviderConnector;
use Symfony\Bundle\FrameworkBundle\Controller\AbstractController;
use Symfony\Component\DependencyInjection\Attribute\Autowire;
use Symfony\Component\HttpFoundation\RedirectResponse;
use Symfony\Component\HttpFoundation\Request;
use Symfony\Component\HttpKernel\Exception\NotFoundHttpException;
use Symfony\Component\Routing\Attribute\Route;

/**
 * Where Google and Microsoft send the browser back after a sign-in. Public: it passes the provider's answer on to the
 * web app, which finishes the sign-in with its own access token (POST /api/v1/provider-connections). Requiring the
 * API's browser session here sent everyone whose session had ended (24 idle minutes, or a deploy) to Tresso's
 * sign-in page, as if they had been signed out.
 */
final class ProviderConnectController extends AbstractController
{
    public function __construct(
        private readonly ProviderConnector $connector,
        #[Autowire(env: 'WEB_APP_URL')]
        private readonly string $webAppUrl,
    ) {
    }

    #[Route('/connect/{provider}/callback', name: 'provider_connect_callback', methods: ['GET'])]
    public function callback(string $provider, Request $request): RedirectResponse
    {
        $oauthProvider = OAuthProvider::tryFrom($provider) ?? throw new NotFoundHttpException('Unknown provider.');
        $result = $this->connector->returnFrom($oauthProvider, $request->query->all());

        $response = new RedirectResponse(rtrim($this->webAppUrl, '/').$result->path.'?'.http_build_query($result->query));
        // The URL held a one-time code; keep it out of other sites' Referer headers and out of caches.
        $response->headers->set('Referrer-Policy', 'no-referrer');
        $response->headers->set('Cache-Control', 'no-store');

        return $response;
    }
}
