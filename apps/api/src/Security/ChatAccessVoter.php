<?php

declare(strict_types=1);

namespace App\Security;

use Symfony\Component\Security\Core\Authentication\Token\TokenInterface;
use Symfony\Component\Security\Core\Authorization\Voter\Vote;
use Symfony\Component\Security\Core\Authorization\Voter\Voter;

/**
 * Who reaches WhatsApp chats; every chat endpoint and the chat lists of the delta ask this voter, nothing else.
 *
 * - Our own apps (web, desktop, mobile) with the mail scope of the action: `mail:read` to read, `mail:send` to queue a
 *   reply, `mail:write` to change or remove the chat account. Sessions from before chats hold no chat scope, so our apps
 *   need none.
 * - Any other caller (an app that is not ours, an MCP client, a personal access token) only with a chat scope:
 *   `chat:read` to read, `chat:send` to queue a reply. No other scope implies them, so no grant from before gains
 *   chats. Changing or removing the chat account stays with our own apps.
 *
 * @extends Voter<string, mixed>
 */
final class ChatAccessVoter extends Voter
{
    /** Read chat accounts, chats, messages and replies. */
    public const string READ = 'CHAT_READ';

    /** Queue a reply. */
    public const string SEND = 'CHAT_SEND';

    /** Change or remove the chat account. */
    public const string MANAGE = 'CHAT_MANAGE';

    protected function supports(string $attribute, mixed $subject): bool
    {
        return \in_array($attribute, [self::READ, self::SEND, self::MANAGE], true);
    }

    protected function voteOnAttribute(string $attribute, mixed $subject, TokenInterface $token, ?Vote $vote = null): bool
    {
        $roles = $token->getRoleNames();
        $ourApp = FirstPartyClients::signedRequest($token);

        return match ($attribute) {
            self::READ => ($ourApp && \in_array(Scope::ROLE_MAIL_READ, $roles, true)) || \in_array(Scope::ROLE_CHAT_READ, $roles, true),
            self::SEND => ($ourApp && \in_array(Scope::ROLE_MAIL_SEND, $roles, true)) || \in_array(Scope::ROLE_CHAT_SEND, $roles, true),
            self::MANAGE => $ourApp && \in_array(Scope::ROLE_MAIL_WRITE, $roles, true),
            default => false,
        };
    }
}
