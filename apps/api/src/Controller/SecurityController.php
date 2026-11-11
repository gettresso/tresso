<?php

declare(strict_types=1);

namespace App\Controller;

use App\Security\SignOutGuard;
use Symfony\Bundle\FrameworkBundle\Controller\AbstractController;
use Symfony\Component\HttpFoundation\Response;
use Symfony\Component\Routing\Attribute\Route;
use Symfony\Component\Security\Http\Authentication\AuthenticationUtils;

/**
 * Browser sign-in used by the OAuth2 authorization endpoint. Clients never post credentials to the API directly.
 */
final class SecurityController extends AbstractController
{
    #[Route('/login', name: 'app_login', methods: ['GET', 'POST'])]
    public function login(AuthenticationUtils $authenticationUtils): Response
    {
        $response = $this->render('security/login.html.twig', [
            'last_username' => $authenticationUtils->getLastUsername(),
            'error' => $authenticationUtils->getLastAuthenticationError(),
        ]);

        // A password form: never inside someone else's page (clickjacking), never cached.
        $response->headers->set('X-Frame-Options', 'DENY');
        $response->headers->set('Content-Security-Policy', "frame-ancestors 'none'");
        $response->headers->set('Cache-Control', 'no-store, private');
        $response->headers->set('Referrer-Policy', 'same-origin');

        return $response;
    }

    /**
     * Never reached: {@see SignOutGuard} answers GET with a page and passes on only a POST from Tresso, which the
     * firewall's logout listener handles.
     */
    #[Route(SignOutGuard::PATH, name: 'app_logout', methods: ['GET', 'HEAD', 'POST'])]
    public function logout(): never
    {
        throw new \LogicException('Intercepted by the logout key on the firewall.');
    }
}
