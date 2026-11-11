<?php

declare(strict_types=1);

namespace App\Security;

use Symfony\Component\DependencyInjection\Attribute\Autowire;
use Symfony\Component\EventDispatcher\Attribute\AsEventListener;
use Symfony\Component\HttpFoundation\RedirectResponse;
use Symfony\Component\HttpFoundation\Request;
use Symfony\Component\HttpFoundation\Response;
use Symfony\Component\HttpKernel\Event\RequestEvent;
use Symfony\Component\HttpKernel\KernelEvents;
use Symfony\Component\Security\Csrf\CsrfToken;
use Symfony\Component\Security\Csrf\CsrfTokenManagerInterface;
use Symfony\Component\Security\Http\Event\LogoutEvent;
use Twig\Environment;

/**
 * Lets only a deliberate sign-out end the browser's sign-in (the session and the remember-me cookie of the firewall
 * `main`), so another site cannot sign people out with an image or a form of its own.
 *
 * Runs before the firewall, whose logout listener would otherwise end the sign-in on any request to /logout:
 * - GET shows a page with a Sign out button (or, when this browser is not signed in, goes straight back to the web
 *   app). A link or a navigation never signs anyone out by itself.
 * - POST goes on to the firewall when it comes from Tresso: an Origin header of this server or of the web app (the web
 *   app signs out by submitting a form here), or, from a browser that sends no usable Origin, the page's CSRF token.
 *   Anything else gets the page again with a 403, and nothing happens.
 *
 * After signing out the browser goes to the web app. The firewall's own `logout.target` cannot do that: Symfony only
 * redirects to the host of the request there, and the web app usually has another one.
 */
#[AsEventListener(event: KernelEvents::REQUEST, method: '__invoke', priority: self::PRIORITY)]
#[AsEventListener(event: LogoutEvent::class, method: 'backToTheApp', dispatcher: 'security.event_dispatcher.main', priority: -64)]
final readonly class SignOutGuard
{
    public const string PATH = '/logout';
    public const string CSRF_TOKEN_ID = 'logout';
    public const string REMEMBER_ME_COOKIE = 'REMEMBERME';

    /** Above the firewall (8), below the router (32) and the session (128). */
    private const int PRIORITY = 9;

    private string $webAppUrl;

    public function __construct(
        private CsrfTokenManagerInterface $csrfTokens,
        private Environment $twig,
        #[Autowire(env: 'WEB_APP_URL')]
        string $webAppUrl,
    ) {
        $this->webAppUrl = rtrim($webAppUrl, '/');
    }

    public function __invoke(RequestEvent $event): void
    {
        $request = $event->getRequest();
        if (!$event->isMainRequest() || self::PATH !== $request->getPathInfo()) {
            return;
        }

        if ($request->isMethod('POST')) {
            if (!$this->fromTresso($request)) {
                $event->setResponse($this->page($request, 'This sign-out came from another site, so nothing happened. Sign out here if you meant to.'));
            }

            return;
        }

        if (!$request->isMethod('GET') && !$request->isMethod('HEAD')) {
            $event->setResponse(new Response('', Response::HTTP_METHOD_NOT_ALLOWED, ['Allow' => 'GET, HEAD, POST']));

            return;
        }

        if (!$request->hasPreviousSession() && !$request->cookies->has(self::REMEMBER_ME_COOKIE)) {
            $event->setResponse(new RedirectResponse($this->webAppUrl));

            return;
        }

        $event->setResponse($this->page($request));
    }

    /**
     * After the firewall's own logout listeners: the default one set a redirect to "/", and the others added the
     * cookies that clear the session and the remember-me cookie to that response, so only its target changes.
     */
    public function backToTheApp(LogoutEvent $event): void
    {
        $response = $event->getResponse();
        if ($response instanceof RedirectResponse) {
            $response->setTargetUrl($this->webAppUrl);

            return;
        }

        $redirect = new RedirectResponse($this->webAppUrl);
        foreach ($response?->headers->getCookies() ?? [] as $cookie) {
            $redirect->headers->setCookie($cookie);
        }
        $event->setResponse($redirect);
    }

    private function fromTresso(Request $request): bool
    {
        $origin = $request->headers->get('Origin');
        if (null !== $origin && 'null' !== $origin) {
            return \in_array($origin, [$request->getSchemeAndHttpHost(), $this->webAppUrl], true);
        }

        return $this->csrfTokens->isTokenValid(new CsrfToken(self::CSRF_TOKEN_ID, $request->request->getString('_csrf_token')));
    }

    private function page(Request $request, ?string $error = null): Response
    {
        $response = new Response($this->twig->render('security/logout.html.twig', [
            'action' => $request->getBaseUrl().self::PATH,
            'error' => $error,
            'csrf_token_id' => self::CSRF_TOKEN_ID,
            'web_app_url' => $this->webAppUrl,
        ]), null === $error ? Response::HTTP_OK : Response::HTTP_FORBIDDEN);

        // Never inside someone else's page, never cached. Same-origin referrers so the form's POST carries an Origin.
        $response->headers->set('X-Frame-Options', 'DENY');
        $response->headers->set('Content-Security-Policy', "frame-ancestors 'none'");
        $response->headers->set('Cache-Control', 'no-store, private');
        $response->headers->set('Referrer-Policy', 'same-origin');

        return $response;
    }
}
