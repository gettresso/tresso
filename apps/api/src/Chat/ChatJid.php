<?php

declare(strict_types=1);

namespace App\Chat;

use App\Enum\ChatKind;

/**
 * Which WhatsApp JIDs name a chat Tresso takes, as `importableChat` in packages/core/src/chat/format.ts decides it (the
 * desktop relays nothing else): direct chats are `<digits>@s.whatsapp.net` (a phone number) and `<digits>@lid` (a
 * hidden number), groups are `@g.us`. Status updates (`status@broadcast`), channels (`@newsletter`), bots (`@bot`), the
 * server itself (`0@s.whatsapp.net`), `@c.us`, `@hosted` and anything else are not chats.
 *
 * A JID is compared in lower case and without its agent and device suffix (`123.0:4@...`): {@see canonical()} is the
 * one form the server stores, fingerprints and hands back, so one chat never becomes two.
 */
final readonly class ChatJid
{
    /** `<user>[.<agent>][:<device>]@<server>`, compared in lower case. The same expression as JID in format.ts. */
    public const string PATTERN = '/^([0-9]+(?:-[0-9]+)?)(?:\.[0-9]+)?(?::[0-9]+)?@([a-z.]+)$/D';

    private function __construct(
        public ChatKind $kind,
        public string $user,
        public string $server,
    ) {
    }

    /** The chat a JID names, or null when it is not a chat Tresso takes. */
    public static function parse(#[\SensitiveParameter] string $jid): ?self
    {
        // Only ASCII can match, and JavaScript's toLowerCase() lowers ASCII as strtolower() does.
        if (1 !== preg_match(self::PATTERN, strtolower($jid), $match)) {
            return null;
        }
        [, $user, $server] = $match;
        if (1 === preg_match('/^0+$/D', str_replace('-', '', $user))) {
            return null;
        }
        if ('g.us' === $server) {
            return new self(ChatKind::Group, $user, $server);
        }
        if (('s.whatsapp.net' === $server || 'lid' === $server) && 1 === preg_match('/^[0-9]+$/D', $user)) {
            return new self(ChatKind::Direct, $user, $server);
        }

        return null;
    }

    /** `<user>@<server>` in lower case. */
    public function canonical(): string
    {
        return $this->user.'@'.$this->server;
    }
}
