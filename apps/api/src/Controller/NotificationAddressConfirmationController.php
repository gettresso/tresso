<?php

declare(strict_types=1);

namespace App\Controller;

use App\Notification\NotificationEmailAddress;
use Symfony\Bundle\FrameworkBundle\Controller\AbstractController;
use Symfony\Component\HttpFoundation\Request;
use Symfony\Component\HttpFoundation\Response;
use Symfony\Component\HttpFoundation\UriSigner;
use Symfony\Component\Routing\Attribute\Route;

/**
 * The link Tresso mails to a notification address that waits for confirmation ({@see NotificationEmailAddress}). The
 * signed, expiring link is the proof that whoever opens it reads that mailbox. GET only shows a page with a button,
 * since mail scanners open links; the button posts the same signed link and confirms. A link works while its address
 * is still the pending one, so it is used up by its confirmation, or by choosing another address.
 */
final class NotificationAddressConfirmationController extends AbstractController
{
    public const string ROUTE = 'notification_address_confirm';

    public function __construct(
        private readonly UriSigner $signer,
        private readonly NotificationEmailAddress $addresses,
    ) {
    }

    #[Route('/notification-address/confirm', name: self::ROUTE, methods: ['GET', 'POST'])]
    public function confirm(Request $request): Response
    {
        $user = $request->query->getString('user');
        $address = $request->query->getString('address');
        if (!$this->signer->checkRequest($request) || !$this->addresses->isPending($user, $address)) {
            return $this->page('expired', $address, Response::HTTP_GONE);
        }
        if (!$request->isMethod('POST')) {
            return $this->page('ask', $address);
        }

        return $this->addresses->confirm($user, $address) ? $this->page('confirmed', $address) : $this->page('expired', $address, Response::HTTP_GONE);
    }

    private function page(string $state, string $address, int $status = Response::HTTP_OK): Response
    {
        $response = $this->render('notification/confirm_address.html.twig', ['state' => $state, 'address' => $address], new Response(status: $status));
        // Never inside someone else's page, never cached, and the signed link never leaves in a Referer.
        $response->headers->set('X-Frame-Options', 'DENY');
        $response->headers->set('Content-Security-Policy', "frame-ancestors 'none'");
        $response->headers->set('Cache-Control', 'no-store, private');
        $response->headers->set('Referrer-Policy', 'no-referrer');

        return $response;
    }
}
