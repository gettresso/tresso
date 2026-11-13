<?php

declare(strict_types=1);

namespace App\Tests\Unit\Calendar;

use App\Calendar\MeetingLinkAddress;
use PHPUnit\Framework\Attributes\DataProvider;
use PHPUnit\Framework\TestCase;

/**
 * The form a pasted meeting link must have, checked against the cases in packages/core/src/calendar/meeting-links.json
 * (which the clients check their own rule against) and against the length limit, which a JSON case cannot show well.
 *
 * The dev container mounts apps/api only, so there the shared cases are skipped; in CI (the whole repository) a missing
 * file fails the test.
 */
final class MeetingLinkAddressTest extends TestCase
{
    private const string CASES = '/packages/core/src/calendar/meeting-links.json';

    /**
     * @return iterable<string, array{string, ?string}>
     */
    public static function cases(): iterable
    {
        $source = self::source();
        if (null === $source) {
            yield 'packages/core is not here' => ['', null];

            return;
        }
        $file = json_decode($source, true, flags: \JSON_THROW_ON_ERROR);
        $cases = \is_array($file) ? ($file['cases'] ?? null) : null;
        if (!\is_array($cases) || [] === $cases) {
            throw new \UnexpectedValueException('meeting-links.json holds no cases.');
        }
        $messages = ['https' => MeetingLinkAddress::NOT_HTTPS, 'credentials' => MeetingLinkAddress::HAS_CREDENTIALS];
        foreach ($cases as $case) {
            $problem = \is_array($case) ? ($case['problem'] ?? null) : null;
            $message = \is_string($problem) ? ($messages[$problem] ?? false) : $problem;
            if (!\is_array($case) || !\is_string($case['link'] ?? null) || !\is_bool($case['valid'] ?? null) || (null !== $message && !\is_string($message)) || $case['valid'] !== (null === $message)) {
                throw new \UnexpectedValueException('A case of meeting-links.json is not {link, valid, problem: null|https|credentials}.');
            }
            yield var_export($case['link'], true) => [$case['link'], $message];
        }
    }

    #[DataProvider('cases')]
    public function testKeepsTheLinksTheClientsKeep(string $link, ?string $message): void
    {
        $this->requireCore();

        self::assertSame($message, MeetingLinkAddress::violation($link));
    }

    public function testTheSharedCasesAreThere(): void
    {
        $this->requireCore();

        self::assertNotNull(self::source(), 'packages/core/src/calendar/meeting-links.json is missing.');
        self::assertGreaterThan(20, iterator_count(self::cases()));
    }

    public function testALinkMayBe2048CharactersLong(): void
    {
        $base = 'https://meet.company.example/';
        $longest = $base.str_repeat('a', MeetingLinkAddress::MAX_LENGTH - \strlen($base));

        self::assertNull(MeetingLinkAddress::violation($longest));
        self::assertSame(MeetingLinkAddress::TOO_LONG, MeetingLinkAddress::violation($longest.'a'));
        self::assertNull(MeetingLinkAddress::violation($base.str_repeat('ü', MeetingLinkAddress::MAX_LENGTH - \strlen($base))), 'Characters are counted, not bytes.');
    }

    public function testBytesThatAreNotUtf8AreRefused(): void
    {
        self::assertSame(MeetingLinkAddress::NOT_HTTPS, MeetingLinkAddress::violation("https://meet.company.example/\xC3\x28"));
    }

    public function testNoMessageRepeatsTheLink(): void
    {
        foreach (['http://secret-room.example/abc', 'https://kim:hunter2@secret-room.example/abc', 'https://secret-room.example/'.str_repeat('x', 2100)] as $link) {
            $message = MeetingLinkAddress::violation($link);
            self::assertNotNull($message);
            self::assertStringNotContainsString('secret-room', $message);
            self::assertStringNotContainsString('hunter2', $message);
        }
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

    private static function source(): ?string
    {
        $source = @file_get_contents(self::root().self::CASES);

        return false === $source ? null : $source;
    }

    private static function root(): string
    {
        return \dirname(__DIR__, 5);
    }
}
