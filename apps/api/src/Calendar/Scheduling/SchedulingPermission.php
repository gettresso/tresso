<?php

declare(strict_types=1);

namespace App\Calendar\Scheduling;

use App\Security\Scope;
use Symfony\Bundle\SecurityBundle\Security;
use Symfony\Component\HttpKernel\Exception\AccessDeniedHttpException;

/**
 * Invitations, updates, cancellations and replies are mail in the user's name, whether we send them (iTIP) or the
 * provider does: a request that would send one needs mail:send, not only calendar:write. Without it the change is
 * refused (and rolled back with its transaction) rather than quietly made without telling anyone; a client that
 * means to tell nobody says notify=false. Work without a signed-in caller (the system itself) is not limited here.
 */
final readonly class SchedulingPermission
{
    public function __construct(private Security $security)
    {
    }

    public function assertMaySend(): void
    {
        if (null === $this->security->getToken() || $this->security->isGranted(Scope::ROLE_MAIL_SEND)) {
            return;
        }

        throw new AccessDeniedHttpException('Telling attendees or the organizer sends mail in your name and needs the mail:send permission. Ask for it, or set notify to false to change only the calendar.');
    }
}
