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
    /** What each error means for the user, in our words. */
    private const array EXPLANATIONS = [
        'invalid_request' => 'The app sent an incomplete or malformed request.',
        'invalid_scope' => 'The app asked for permissions it cannot have.',
        'invalid_target' => 'The app asked for access to something this server does not protect.',
        'unsupported_response_type' => 'The app asked to sign in in a way this server does not support.',
        'unauthorized_client' => 'The app may not sign in this way.',
        'server_error' => 'Something went wrong on our side. Try again later.',
        'temporarily_unavailable' => 'Signing in to apps is not possible right now. Try again later.',
    ];

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

        // Only our own words: the description and hint of an error can repeat what the request held (a scope, a URI),
        // and that text is the app's, not ours.
        $known = \array_key_exists($error, self::EXPLANATIONS);
        $page = new Response($this->twig->render('security/authorize_error.html.twig', [
            'error' => $known ? $error : null,
            'explanation' => self::EXPLANATIONS[$known ? $error : 'invalid_request'],
        ]), Response::HTTP_BAD_REQUEST);
        $page->headers->set('X-Frame-Options', 'DENY');
        $page->headers->set('Content-Security-Policy', "frame-ancestors 'none'");
        $page->headers->set('Cache-Control', 'no-store, private');
        $page->headers->set('Referrer-Policy', 'no-referrer');
        $event->setResponse($page);
    }
}
