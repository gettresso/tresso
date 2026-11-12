<?php

declare(strict_types=1);

namespace App\Tests\Unit\Chat;

use App\Chat\ChatJid;
use App\Enum\ChatKind;
use PHPUnit\Framework\Attributes\DataProvider;
use PHPUnit\Framework\TestCase;

/**
 * The server takes the chats the desktop relays and nothing else: the rule of `importableChat` in
 * packages/core/src/chat/format.ts, checked against the cases in packages/core/src/chat/importable-jids.json (which
 * format.test.ts reads as well) and against the expression in format.ts itself.
 *
 * The dev container mounts apps/api only, so there the test is skipped; in CI (the whole repository) a missing file
 * fails it.
 */
final class ChatJidTest extends TestCase
{
    private const string FORMAT = '/packages/core/src/chat/format.ts';
    private const string CASES = '/packages/core/src/chat/importable-jids.json';

    /**
     * @return iterable<string, array{string, bool, ?string, ?string}>
     */
    public static function cases(): iterable
    {
        $source = self::source(self::CASES);
        if (null === $source) {
            yield 'packages/core is not here' => ['', false, null, null];

            return;
        }
        $file = json_decode($source, true, flags: \JSON_THROW_ON_ERROR);
        $cases = \is_array($file) ? ($file['cases'] ?? null) : null;
        if (!\is_array($cases) || [] === $cases) {
            throw new \UnexpectedValueException('importable-jids.json holds no cases.');
        }
        foreach ($cases as $case) {
            if (!\is_array($case) || !\is_string($case['jid'] ?? null) || !\is_bool($case['chat'] ?? null)) {
                throw new \UnexpectedValueException('A case of importable-jids.json is not {jid, chat, kind?, canonical?}.');
            }
            $kind = $case['kind'] ?? null;
            $canonical = $case['canonical'] ?? null;
            yield var_export($case['jid'], true) => [$case['jid'], $case['chat'], \is_string($kind) ? $kind : null, \is_string($canonical) ? $canonical : null];
        }
    }

    #[DataProvider('cases')]
    public function testTakesTheChatsCoreTakes(string $jid, bool $chat, ?string $kind, ?string $canonical): void
    {
        $this->requireCore();

        $address = ChatJid::parse($jid);

        if (!$chat) {
            self::assertNull($address);

            return;
        }
        self::assertNotNull($address);
        self::assertSame($kind, $address->kind->value);
        self::assertSame(ChatKind::from((string) $kind), $address->kind);
        self::assertSame($canonical, $address->canonical());
    }

    public function testTheSharedCasesAreThere(): void
    {
        $this->requireCore();

        self::assertNotNull(self::source(self::CASES), 'packages/core/src/chat/importable-jids.json is missing.');
        self::assertGreaterThan(20, iterator_count(self::cases()));
    }

    public function testTheRuleIsTheOneOfCore(): void
    {
        $this->requireCore();
        $source = self::source(self::FORMAT);
        self::assertIsString($source, 'packages/core/src/chat/format.ts is missing.');
        if (1 !== preg_match('~^const JID = (/.+/)$~m', $source, $match)) {
            self::fail('const JID not found in packages/core/src/chat/format.ts.');
        }

        self::assertSame($match[1].'D', ChatJid::PATTERN, 'Change both, and the cases in importable-jids.json.');
    }

    private function requireCore(): void
    {
        if (is_dir(self::root().'/packages/core')) {
            return;
        }
        if (false !== getenv('CI')) {
            self::fail('packages/core is missing: CI checks out the whole repository.');
        }
        self::markTestSkipped('packages/core is not next to apps/api here (the dev container mounts apps/api only).');
    }

    private static function source(string $path): ?string
    {
        $source = @file_get_contents(self::root().$path);

        return false === $source ? null : $source;
    }

    private static function root(): string
    {
        return \dirname(__DIR__, 5);
    }
}
