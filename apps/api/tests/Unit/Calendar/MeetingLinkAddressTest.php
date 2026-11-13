<?php

declare(strict_types=1);

namespace App\Tests\Unit\Calendar;

use App\Calendar\MeetingLinkAddress;
use PHPUnit\Framework\Attributes\DataProvider;
use PHPUnit\Framework\TestCase;

/**
 * The form a pasted meeting link must have: the rule of `meetingLinkProblem` in packages/core/src/calendar/meeting.ts,
 * checked against the shared cases in packages/core/src/calendar/meeting-links.json (which meeting.test.ts reads as
 * well), as ChatJidTest does with importable-jids.json, and against the cases below. The dev container mounts apps/api
 * only, so there the shared cases are skipped; in CI (the whole repository) a missing file fails the test.
 */
final class MeetingLinkAddressTest extends TestCase
{
    private const string SHARED_CASES = '/packages/core/src/calendar/meeting-links.json';

    /**
     * @return iterable<string, array{string, ?string}>
     */
    public static function links(): iterable
    {
        yield 'a plain room link' => ['https://meet.company.example/kim', null];
        yield 'a query and a fragment' => ['https://meet.jit.si/Standup?lang=en#config.startWithAudioMuted=true', null];
        yield 'a Zoom link with its passcode' => ['https://zoom.us/j/1234567890?pwd=abcDEF123', null];
        yield 'a Teams link with escapes' => ['https://teams.microsoft.com/l/meetup-join/19%3ameeting_abc%40thread.v2/0?context=%7b%22Tid%22%7d', null];
        yield 'a port' => ['https://whereby.com:443/kim', null];
        yield 'a host with letters outside ASCII' => ['https://bücher.example/raum', null];
        yield 'a host with a trailing dot' => ['https://meet.company.example./kim', null];
        yield 'a hyphen inside a label' => ['https://my-room.company.example/kim', null];
        yield 'empty' => ['', MeetingLinkAddress::EMPTY];
        yield 'http' => ['http://meet.company.example/kim', MeetingLinkAddress::NOT_HTTPS];
        yield 'an upper case scheme, refused as on the clients' => ['HTTPS://meet.company.example/kim', MeetingLinkAddress::NOT_HTTPS];
        yield 'no scheme' => ['meet.company.example/kim', MeetingLinkAddress::NOT_HTTPS];
        yield 'javascript' => ['javascript:alert(1)//https://meet.company.example', MeetingLinkAddress::NOT_HTTPS];
        yield 'a space' => ['https://meet.company.example/kim room', MeetingLinkAddress::WHITESPACE];
        yield 'a space in front' => [' https://meet.company.example/kim', MeetingLinkAddress::WHITESPACE];
        yield 'a line break' => ["https://meet.company.example/kim\n", MeetingLinkAddress::WHITESPACE];
        yield 'a no-break space' => ["https://meet.company.example/\u{A0}kim", MeetingLinkAddress::WHITESPACE];
        yield 'a byte order mark' => ["https://meet.company.example/\u{FEFF}kim", MeetingLinkAddress::WHITESPACE];
        yield 'a NUL' => ["https://meet.company.example/\u{0}kim", MeetingLinkAddress::CONTROL];
        yield 'DEL' => ["https://meet.company.example/\u{7F}kim", MeetingLinkAddress::CONTROL];
        yield 'a right-to-left override' => ["https://meet.company.example/\u{202E}kim", MeetingLinkAddress::CONTROL];
        yield 'a zero width space' => ["https://meet.company.example/\u{200B}kim", MeetingLinkAddress::CONTROL];
        yield 'a Hangul filler' => ["https://meet.company.example/\u{3164}kim", MeetingLinkAddress::CONTROL];
        yield 'a Hangul choseong filler' => ["https://meet\u{115F}.company.example/kim", MeetingLinkAddress::CONTROL];
        yield 'a Hangul jungseong filler' => ["https://meet.company.example/\u{1160}", MeetingLinkAddress::CONTROL];
        yield 'a halfwidth Hangul filler' => ["https://meet.company.example/\u{FFA0}", MeetingLinkAddress::CONTROL];
        yield 'a backslash' => ['https://good.example\\@evil.example/kim', MeetingLinkAddress::INVALID];
        yield 'a name and password' => ['https://kim:secret@meet.company.example/kim', MeetingLinkAddress::CREDENTIALS];
        yield 'a name' => ['https://kim@meet.company.example/kim', MeetingLinkAddress::CREDENTIALS];
        yield 'a host that hides another' => ['https://meet.company.example@evil.example/kim', MeetingLinkAddress::CREDENTIALS];
        yield 'no host' => ['https://', MeetingLinkAddress::NO_HOST];
        yield 'an empty host' => ['https:///kim', MeetingLinkAddress::NO_HOST];
        yield 'localhost' => ['https://localhost/kim', MeetingLinkAddress::NO_HOST];
        yield 'a host without a dot' => ['https://intranet/kim', MeetingLinkAddress::NO_HOST];
        yield 'an IPv4 address' => ['https://192.0.2.10/room', MeetingLinkAddress::NO_HOST];
        yield 'a last label of digits' => ['https://meet.123/room', MeetingLinkAddress::NO_HOST];
        yield 'a last label in hex' => ['https://meet.0x7f/room', MeetingLinkAddress::NO_HOST];
        yield 'a fullwidth digit in the last label' => ["https://127.0.0.\u{FF11}/", MeetingLinkAddress::NO_HOST];
        yield 'a fullwidth x in a hex last label' => ["https://1.0\u{FF58}7f/", MeetingLinkAddress::NO_HOST];
        yield 'an IPv6 address' => ['https://[2001:db8::1]/kim', MeetingLinkAddress::NO_HOST];
        yield 'an empty label' => ['https://meet..example/kim', MeetingLinkAddress::INVALID];
        yield 'a label that starts with a dot' => ['https://.example/kim', MeetingLinkAddress::INVALID];
        yield 'an underscore in the host' => ['https://meet_room.company.example/kim', MeetingLinkAddress::INVALID];
        yield 'a hyphen at the end of a label' => ['https://meet-.company.example/kim', MeetingLinkAddress::INVALID];
        yield 'a label of 64 characters' => ['https://'.str_repeat('a', 64).'.example/kim', MeetingLinkAddress::INVALID];
        yield 'a label of 63 characters' => ['https://'.str_repeat('a', 63).'.example/kim', null];
        yield 'port 0' => ['https://meet.company.example:0/kim', MeetingLinkAddress::INVALID];
        yield 'port 65536' => ['https://meet.company.example:65536/kim', MeetingLinkAddress::INVALID];
        yield 'port 65535' => ['https://meet.company.example:65535/kim', null];
        yield 'an empty port' => ['https://meet.company.example:/kim', MeetingLinkAddress::INVALID];
        yield 'a port that is no number' => ['https://meet.company.example:https/kim', MeetingLinkAddress::INVALID];
    }

    #[DataProvider('links')]
    public function testFindsWhatIsWrongWithALink(string $link, ?string $problem): void
    {
        self::assertSame($problem, MeetingLinkAddress::problem($link));
        self::assertSame(null === $problem, null === MeetingLinkAddress::violation($link));
    }

    public function testALinkMayBe2048CharactersLongAsTheClientsCountThem(): void
    {
        $base = 'https://meet.company.example/';
        $longest = $base.str_repeat('a', MeetingLinkAddress::MAX_LENGTH - \strlen($base));

        self::assertNull(MeetingLinkAddress::problem($longest));
        self::assertSame(MeetingLinkAddress::TOO_LONG, MeetingLinkAddress::problem($longest.'a'));
        self::assertSame('Use a link of at most 2048 characters.', MeetingLinkAddress::violation($longest.'a'));
        self::assertNull(MeetingLinkAddress::problem($base.str_repeat('ü', MeetingLinkAddress::MAX_LENGTH - \strlen($base))), 'One character each.');
        self::assertSame(MeetingLinkAddress::TOO_LONG, MeetingLinkAddress::problem($base.str_repeat("\u{1F600}", 1010)), 'An emoji counts twice, as in JavaScript.');
    }

    public function testBytesThatAreNotUtf8AreRefused(): void
    {
        self::assertSame(MeetingLinkAddress::CONTROL, MeetingLinkAddress::problem("https://meet.company.example/\xC3\x28"));
    }

    public function testTheMessagesAreTheClientsAndNeverRepeatTheLink(): void
    {
        self::assertSame('Use a link that starts with https://.', MeetingLinkAddress::violation('http://secret-room.example/abc'));
        self::assertSame('Use a link without a user name or password in it.', MeetingLinkAddress::violation('https://kim:hunter2@secret-room.example/abc'));
        self::assertSame('Use a link without spaces, line breaks or hidden characters.', MeetingLinkAddress::violation('https://secret-room.example/a b'));
        self::assertSame('Use a link with a full web address, such as https://meet.example.com/room.', MeetingLinkAddress::violation('https://secret-room/abc'));
        self::assertSame('This link does not look right. Check it and paste it again.', MeetingLinkAddress::violation('https://secret_room.example/abc'));
        foreach (['http://secret-room.example/abc', 'https://kim:hunter2@secret-room.example/abc', 'https://secret-room.example/'.str_repeat('x', 2100)] as $link) {
            $message = (string) MeetingLinkAddress::violation($link);
            self::assertStringNotContainsString('secret-room', $message);
            self::assertStringNotContainsString('hunter2', $message);
        }
    }

    /**
     * The shared cases of packages/core: {description, cases: [{name, link, ownLink, join, problem}]}, with `problem`
     * the code of meetingLinkProblem (null when the link may be used) and `ownLink` whether it is taken as an own link.
     *
     * @return iterable<string, array{string, bool, ?string}>
     */
    public static function sharedCases(): iterable
    {
        $source = self::source();
        if (null === $source) {
            // requireCore() below fails or skips the test before these arguments are used.
            yield 'packages/core is not here' => ['', false, null];

            return;
        }
        $file = json_decode($source, true, flags: \JSON_THROW_ON_ERROR);
        $cases = \is_array($file) ? ($file['cases'] ?? null) : null;
        if (!\is_array($cases) || [] === $cases) {
            throw new \UnexpectedValueException('meeting-links.json holds no cases.');
        }
        foreach ($cases as $case) {
            if (!\is_array($case) || !\is_string($case['name'] ?? null) || !\is_string($case['link'] ?? null) || !\is_bool($case['ownLink'] ?? null)
                || !\array_key_exists('problem', $case) || (null !== $case['problem'] && !\is_string($case['problem']))) {
                throw new \UnexpectedValueException('A case of meeting-links.json is not {name, link, ownLink, join, problem}.');
            }
            yield $case['name'] => [$case['link'], $case['ownLink'], $case['problem']];
        }
    }

    #[DataProvider('sharedCases')]
    public function testFindsWhatPackagesCoreFinds(string $link, bool $ownLink, ?string $problem): void
    {
        $this->requireCore();

        self::assertSame($problem, MeetingLinkAddress::problem($link));
        self::assertSame($ownLink, null === $problem);
    }

    public function testTheSharedCasesAreThere(): void
    {
        $this->requireCore();

        self::assertNotNull(self::source(), 'packages/core/src/calendar/meeting-links.json is missing.');
        self::assertGreaterThanOrEqual(84, iterator_count(self::sharedCases()));
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
        $source = @file_get_contents(self::root().self::SHARED_CASES);

        return false === $source ? null : $source;
    }

    private static function root(): string
    {
        return \dirname(__DIR__, 5);
    }
}
