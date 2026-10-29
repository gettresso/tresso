<?php

declare(strict_types=1);

namespace App\Tests\Unit\Deployment;

use App\Deployment\CorsOrigins;
use PHPUnit\Framework\TestCase;

final class CorsOriginsTest extends TestCase
{
    public function testAListAllowsExactlyThoseOrigins(): void
    {
        $pattern = '{'.CorsOrigins::pattern(' https://mail.example.com  tauri://localhost http://tauri.localhost ').'}i';

        foreach (['https://mail.example.com', 'tauri://localhost', 'http://tauri.localhost'] as $allowed) {
            self::assertSame(1, preg_match($pattern, $allowed), $allowed);
        }
        foreach (['https://mailxexample.com', 'https://mail.example.com.evil.com', 'https://evil.mail.example.com', 'http://tauri.localhost.evil.com', 'https://mail.example.com:8443'] as $refused) {
            self::assertSame(0, preg_match($pattern, $refused), $refused);
        }
    }

    public function testAPatternStaysAsItIs(): void
    {
        self::assertSame('^(https?://localhost(:[0-9]+)?)$', CorsOrigins::pattern('^(https?://localhost(:[0-9]+)?)$'));
    }

    public function testAnEmptyListAllowsNoOrigin(): void
    {
        $pattern = '{'.CorsOrigins::pattern('  ').'}i';

        self::assertSame(0, preg_match($pattern, 'https://mail.example.com'));
        self::assertSame(0, preg_match($pattern, ''));
    }
}
