<?php

declare(strict_types=1);

namespace App\Tests\Unit\Chat;

use App\Chat\ChatJid;
use App\Enum\ChatKind;
use PHPUnit\Framework\Attributes\DataProvider;
use PHPUnit\Framework\TestCase;

/**
 * The server takes the chats the desktop relays and nothing else: the rule of `importableChat` in
 * packages/core/src/chat/format.ts, with the cases of its test (format.test.ts).
 */
final class ChatJidTest extends TestCase
{
    private const string FORMAT = '/packages/core/src/chat/format.ts';

    /**
     * @return iterable<string, array{string, ChatKind, string}>
     */
    public static function chats(): iterable
    {
        yield 'a phone number' => ['31612345678@s.whatsapp.net', ChatKind::Direct, '31612345678@s.whatsapp.net'];
        yield 'a hidden number' => ['84932172912345@lid', ChatKind::Direct, '84932172912345@lid'];
        yield 'a group' => ['120363025246125486@g.us', ChatKind::Group, '120363025246125486@g.us'];
        yield 'an old group' => ['31612345678-1600000000@g.us', ChatKind::Group, '31612345678-1600000000@g.us'];
        yield 'upper case' => ['31612345678@S.WhatsApp.Net', ChatKind::Direct, '31612345678@s.whatsapp.net'];
        yield 'a device suffix' => ['31612345678:12@s.whatsapp.net', ChatKind::Direct, '31612345678@s.whatsapp.net'];
        yield 'an agent and a device' => ['31612345678.0:3@s.whatsapp.net', ChatKind::Direct, '31612345678@s.whatsapp.net'];
        yield 'a group in upper case' => ['120363025246125486@G.US', ChatKind::Group, '120363025246125486@g.us'];
    }

    #[DataProvider('chats')]
    public function testTakesDirectChatsAndGroups(string $jid, ChatKind $kind, string $canonical): void
    {
        $address = ChatJid::parse($jid);

        self::assertNotNull($address);
        self::assertSame($kind, $address->kind);
        self::assertSame($canonical, $address->canonical());
    }

    /**
     * @return iterable<string, array{string}>
     */
    public static function notChats(): iterable
    {
        foreach ([
            '0@s.whatsapp.net',
            'status@broadcast',
            '120363144038483540@newsletter',
            '31612345678@bot',
            '31612345678@c.us',
            '31612345678@hosted',
            'abc@s.whatsapp.net',
            '31612345678-1@s.whatsapp.net',
            '31612345678',
            '',
            ' 31612345678@s.whatsapp.net',
            "31612345678@s.whatsapp.net\n",
            '0-0@g.us',
            '31612345678@s.whatsapp.net.evil',
        ] as $jid) {
            yield var_export($jid, true) => [$jid];
        }
    }

    #[DataProvider('notChats')]
    public function testRefusesEverythingElse(string $jid): void
    {
        self::assertNull(ChatJid::parse($jid));
    }

    public function testTheRuleIsTheOneOfCore(): void
    {
        $root = \dirname(__DIR__, 5);
        if (!is_dir($root.'/packages/core')) {
            self::markTestSkipped('packages/core is not next to apps/api here (the dev container mounts apps/api only).');
        }
        $source = file_get_contents($root.self::FORMAT);
        self::assertIsString($source, 'packages/core/src/chat/format.ts is missing.');
        if (1 !== preg_match('~^const JID = (/.+/)$~m', $source, $match)) {
            self::fail('const JID not found in packages/core/src/chat/format.ts.');
        }

        self::assertSame($match[1].'D', ChatJid::PATTERN, 'Change both, and the cases of both tests.');
    }
}
