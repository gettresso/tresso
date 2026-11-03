<?php

declare(strict_types=1);

namespace App\Mcp\Security;

use App\Entity\User;
use Symfony\Component\Security\Core\Authentication\Token\TokenInterface;
use Symfony\Component\Security\Core\Authorization\Voter\Vote;
use Symfony\Component\Security\Core\Authorization\Voter\Voter;

/**
 * Grants {@see ATTRIBUTE} to a request signed in as a user: a personal access token, a token of one of our own apps or
 * of an app the user allowed. A sync worker's token (client credentials) has no user and is refused, whatever it holds.
 *
 * @extends Voter<string, mixed>
 */
final class McpUserVoter extends Voter
{
    public const string ATTRIBUTE = 'MCP_USER';

    protected function supports(string $attribute, mixed $subject): bool
    {
        return self::ATTRIBUTE === $attribute;
    }

    protected function voteOnAttribute(string $attribute, mixed $subject, TokenInterface $token, ?Vote $vote = null): bool
    {
        if ($token->getUser() instanceof User) {
            return true;
        }

        $vote?->addReason('The MCP endpoint needs a token of a user.');

        return false;
    }
}
