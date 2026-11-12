<?php

declare(strict_types=1);

namespace App\Security;

use Symfony\Component\Security\Core\Authentication\Token\TokenInterface;
use Symfony\Component\Security\Core\Authorization\Voter\Vote;
use Symfony\Component\Security\Core\Authorization\Voter\Voter;

/**
 * Grants {@see FirstPartyClients::ATTRIBUTE} to requests signed by one of our own apps, and
 * {@see FirstPartyClients::DESKTOP_ATTRIBUTE} to those signed by our desktop app.
 *
 * @extends Voter<string, mixed>
 */
final class FirstPartyClientVoter extends Voter
{
    protected function supports(string $attribute, mixed $subject): bool
    {
        return FirstPartyClients::ATTRIBUTE === $attribute || FirstPartyClients::DESKTOP_ATTRIBUTE === $attribute;
    }

    protected function voteOnAttribute(string $attribute, mixed $subject, TokenInterface $token, ?Vote $vote = null): bool
    {
        return FirstPartyClients::DESKTOP_ATTRIBUTE === $attribute
            ? FirstPartyClients::signedByDesktop($token)
            : FirstPartyClients::signedRequest($token);
    }
}
