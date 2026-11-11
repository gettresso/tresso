<?php

declare(strict_types=1);

namespace App\Security;

use App\Deployment\PublicAddresses;
use Symfony\Component\EventDispatcher\Attribute\AsEventListener;
use Symfony\Component\HttpFoundation\RedirectResponse;
use Symfony\Component\HttpKernel\Event\RequestEvent;
use Symfony\Component\HttpKernel\KernelEvents;

/**
 * Sends a browser that opens a sign-in page (/login, /logout, /oauth/authorize) on the API host or the web app's host,
 * while that is not AUTH_PUBLIC_URL, to AUTH_PUBLIC_URL with the same path and query: the sign-in session and the
 * remember-me cookie belong to that host. This keeps installed apps and apps that read older metadata working once
 * sign-in moved, since they open `<API_PUBLIC_URL>/oauth/authorize`; and with the default (AUTH_PUBLIC_URL is the API
 * address) it sends the pages a proxy routes on the web app's host back to the API host, as before. Any other host a
 * request names is left alone.
 *
 * Only GET and HEAD: the pages' forms post to the host they were served from.
 */
#[AsEventListener(event: KernelEvents::REQUEST, priority: self::PRIORITY)]
final readonly class SignInHost
{
    public const array ROUTES = ['app_login', 'app_logout', 'oauth2_authorize'];

    /** Above the sign-out guard (9) and the firewall (8), below the router (32). */
    private const int PRIORITY = 10;

    public function __construct(private PublicAddresses $addresses)
    {
    }

    public function __invoke(RequestEvent $event): void
    {
        $request = $event->getRequest();
        if (!$event->isMainRequest()
            || !\in_array($request->attributes->get('_route'), self::ROUTES, true)
            || (!$request->isMethod('GET') && !$request->isMethod('HEAD'))
            || $this->addresses->isAuthHost($request)
            || (!$this->addresses->isApiHost($request) && !$this->addresses->isWebHost($request))
        ) {
            return;
        }

        $response = new RedirectResponse($this->addresses->auth().$request->getRequestUri());
        $response->headers->set('Cache-Control', 'no-store, private');
        $event->setResponse($response);
    }
}
