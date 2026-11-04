<?php

declare(strict_types=1);

namespace App\Controller;

use App\Enum\OAuthProvider;
use App\Enum\ProviderReturnTarget;
use App\ProviderAuth\ConnectResult;
use App\ProviderAuth\ProviderConnector;
use Symfony\Bundle\FrameworkBundle\Controller\AbstractController;
use Symfony\Component\DependencyInjection\Attribute\Autowire;
use Symfony\Component\HttpFoundation\RedirectResponse;
use Symfony\Component\HttpFoundation\Request;
use Symfony\Component\HttpKernel\Exception\NotFoundHttpException;
use Symfony\Component\Routing\Attribute\Route;

/**
 * Where Google and Microsoft send the browser back after a sign-in. Public: it passes the provider's answer on to the
 * app the sign-in was started in, which finishes it with its own access token (POST /api/v1/provider-connections).
 * Requiring the API's browser session here sent everyone whose session had ended (24 idle minutes, or a deploy) to
 * Tresso's sign-in page, as if they had been signed out.
 *
 * The web app gets the answer on its own page. The desktop app opened the provider in the system browser, whose tabs
 * hold none of its tokens, so the answer goes to the desktop app's link (NATIVE_REDIRECT_URI) instead, with the page
 * to show it on in `next`.
 */
final class ProviderConnectController extends AbstractController
{
    public function __construct(
        private readonly ProviderConnector $connector,
        #[Autowire(env: 'WEB_APP_URL')]
        private readonly string $webAppUrl,
        #[Autowire(env: 'NATIVE_REDIRECT_URI')]
        private readonly string $nativeRedirectUri,
    ) {
    }

    #[Route('/connect/{provider}/callback', name: 'provider_connect_callback', methods: ['GET'])]
    public function callback(string $provider, Request $request): RedirectResponse
    {
        $oauthProvider = OAuthProvider::tryFrom($provider) ?? throw new NotFoundHttpException('Unknown provider.');
        $result = $this->connector->returnFrom($oauthProvider, $request->query->all());

        $response = new RedirectResponse($this->destination($result));
        // The URL held a one-time code; keep it out of other sites' Referer headers and out of caches.
        $response->headers->set('Referrer-Policy', 'no-referrer');
        $response->headers->set('Cache-Control', 'no-store');

        return $response;
    }

    private function destination(ConnectResult $result): string
    {
        return match ($result->target) {
            ProviderReturnTarget::Web => rtrim($this->webAppUrl, '/').$result->path.'?'.http_build_query($result->query),
            ProviderReturnTarget::Native => '' !== $this->nativeRedirectUri
                ? $this->nativeRedirectUri.'?'.http_build_query(['next' => $result->path, ...$result->query])
                : throw new \LogicException('NATIVE_REDIRECT_URI is empty, so a desktop sign-in cannot return to the app.'),
        };
    }
}
