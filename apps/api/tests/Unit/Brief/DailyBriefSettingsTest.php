<?php

declare(strict_types=1);

namespace App\Tests\Unit\Brief;

use App\Entity\DailyBriefSettings;
use App\Entity\User;
use PHPUnit\Framework\TestCase;

final class DailyBriefSettingsTest extends TestCase
{
    public function testAnotherTimeAfterTodaysBriefMakesNoSecondBriefToday(): void
    {
        $settings = new DailyBriefSettings(new User('kim@example.test', 'Kim'), 'UTC', new \DateTimeImmutable('2026-10-20T07:00:00+00:00'));
        $settings->ran(new \DateTimeImmutable('2026-10-20T07:59:59+00:00'), 'UTC', new \DateTimeImmutable('2026-10-20T08:00:00+00:00'));

        $settings->change(true, '18:00', 'UTC', new \DateTimeImmutable('2026-10-20T09:00:00+00:00'));

        self::assertSame('2026-10-21T18:00:00+00:00', $settings->getNextRunAt()->format(\DATE_ATOM));
    }

    public function testAnotherZoneAfterTodaysBriefMakesNoSecondBriefToday(): void
    {
        $settings = new DailyBriefSettings(new User('kim@example.test', 'Kim'), 'UTC', new \DateTimeImmutable('2026-10-20T07:00:00+00:00'));
        $settings->ran(new \DateTimeImmutable('2026-10-20T07:59:59+00:00'), 'UTC', new \DateTimeImmutable('2026-10-20T08:00:00+00:00'));

        $settings->reschedule('America/New_York', new \DateTimeImmutable('2026-10-20T09:00:00+00:00'));

        self::assertSame('2026-10-21T12:00:00+00:00', $settings->getNextRunAt()->format(\DATE_ATOM));
    }

    public function testTheFirstBriefComesTheSameDay(): void
    {
        $settings = new DailyBriefSettings(new User('kim@example.test', 'Kim'), 'UTC', new \DateTimeImmutable('2026-10-20T07:00:00+00:00'));

        self::assertSame('2026-10-20T08:00:00+00:00', $settings->getNextRunAt()->format(\DATE_ATOM));
        self::assertNull($settings->getLastDueDay());
    }

    public function testALateSlotSweptAfterMidnightStillGetsTheNextDaysBrief(): void
    {
        $settings = new DailyBriefSettings(new User('kim@example.test', 'Kim'), 'UTC', new \DateTimeImmutable('2026-10-20T07:00:00+00:00'));
        $settings->change(true, '23:59', 'UTC', new \DateTimeImmutable('2026-10-20T07:00:00+00:00'));
        self::assertSame('2026-10-20T23:59:00+00:00', $settings->getNextRunAt()->format(\DATE_ATOM));

        // The sweep reached it only at 00:00:30 on the 21st.
        $settings->ran(new \DateTimeImmutable('2026-10-21T00:00:29+00:00'), 'UTC', new \DateTimeImmutable('2026-10-21T00:00:30+00:00'));

        self::assertSame('2026-10-20', $settings->getLastDueDay());
        self::assertSame('2026-10-21T23:59:00+00:00', $settings->getNextRunAt()->format(\DATE_ATOM));
    }

    public function testTheBriefDueAgainOnTheDayOneWasMadeCountsAsMade(): void
    {
        $settings = new DailyBriefSettings(new User('kim@example.test', 'Kim'), 'UTC', new \DateTimeImmutable('2026-10-20T07:00:00+00:00'));
        self::assertFalse($settings->isDueBriefMade('UTC'));

        $settings->ran(new \DateTimeImmutable('2026-10-20T07:59:59+00:00'), 'UTC', new \DateTimeImmutable('2026-10-20T08:00:00+00:00'));

        self::assertFalse($settings->isDueBriefMade('UTC'), 'The next one is due tomorrow.');
        $settings->reschedule('Pacific/Kiritimati', new \DateTimeImmutable('2026-10-20T08:00:00+00:00'));
        self::assertFalse($settings->isDueBriefMade('Pacific/Kiritimati'));
    }
}
