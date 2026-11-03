<?php

declare(strict_types=1);

namespace App\Security\OAuth;

use App\Entity\User;
use App\Repository\OAuthConsentRepository;
use App\Security\FirstPartyClients;
use Symfony\Bundle\SecurityBundle\Security;
use Symfony\Component\EventDispatcher\Attribute\AsEventListener;
use Symfony\Component\HttpFoundation\Response;
use Symfony\Component\HttpKernel\Event\ResponseEvent;
use Symfony\Component\HttpKernel\KernelEvents;
use Twig\Environment;

/**
 * Keeps /oauth/authorize from being an open redirect (RFC 9700 4.11.2): anyone can register a client with any redirect
 * URI, so an error about a request (an unknown or refused scope, a resource this server does not protect, ...) is only
 * sent back to that URI when the user already allowed the app. Otherwise the user sees the error here, and the browser
 * goes nowhere. Our own apps keep getting their errors by redirect, and so does `access_denied`: that is the answer the
 * user gave on the consent screen.
 */
#[AsEventListener(event: KernelEvents::RESPONSE)]
final readonly class AuthorizationErrorPage
{
    public function __construct(
        private Security $security,
        private OAuthConsentRepository $consents,
        private Environment $twig,
    ) {
    }

    public function __invoke(ResponseEvent $event): void
    {
        $request = $event->getRequest();
        $response = $event->getResponse();
        if ('oauth2_authorize' !== $request->attributes->get('_route') || !$response->isRedirection()) {
            return;
        }
        $location = (string) $response->headers->get('Location');
        parse_str((string) parse_url($location, \PHP_URL_QUERY), $query);
        $error = $query['error'] ?? null;
        if (!\is_string($error) || 'access_denied' === $error) {
            return;
        }

        $clientId = $request->query->get('client_id');
        if (!\is_string($clientId) || FirstPartyClients::isFirstParty($clientId)) {
            return;
        }
        $user = $this->security->getUser();
        if ($user instanceof User && null !== $this->consents->findOneFor($user, $clientId)) {
            return;
        }

        $description = $query['error_description'] ?? null;
        $hint = $query['hint'] ?? null;
        $page = new Response($this->twig->render('security/authorize_error.html.twig', [
            'error' => $error,
            'description' => \is_string($description) ? $description : null,
            'hint' => \is_string($hint) ? $hint : null,
        ]), Response::HTTP_BAD_REQUEST);
        $page->headers->set('X-Frame-Options', 'DENY');
        $page->headers->set('Content-Security-Policy', "frame-ancestors 'none'");
        $page->headers->set('Cache-Control', 'no-store, private');
        $page->headers->set('Referrer-Policy', 'no-referrer');
        $event->setResponse($page);
    }
}
