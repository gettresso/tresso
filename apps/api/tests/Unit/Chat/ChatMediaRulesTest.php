<?php

declare(strict_types=1);

namespace App\Tests\Unit\Chat;

use App\ApiResource\Input\Chat\QueueReplyFile;
use App\Chat\ChatMediaLimits;
use App\Chat\SweepChatMediaHandler;
use PHPUnit\Framework\Attributes\DataProvider;
use PHPUnit\Framework\TestCase;

/**
 * The bounds and names of WhatsApp files that need no database: the largest file, the name a file goes out under, and
 * the temporary files a killed worker leaves behind.
 */
final class ChatMediaRulesTest extends TestCase
{
    public function testTheLargestFileIsWhatTheMacSends(): void
    {
        self::assertSame(ChatMediaLimits::MAC_MAX_BYTES, new ChatMediaLimits(ChatMediaLimits::MAC_MAX_BYTES)->maxFileBytes);

        $this->expectException(\InvalidArgumentException::class);
        new ChatMediaLimits(ChatMediaLimits::MAC_MAX_BYTES + 1);
    }

    public function testTheSettingIsCheckedAsTheAppStarts(): void
    {
        ChatMediaLimits::check(null);
        ChatMediaLimits::check('104857600');
        ChatMediaLimits::check(4096);
        foreach (['104857601', '0', '-1', '1e6', '', 'ten'] as $wrong) {
            try {
                ChatMediaLimits::check($wrong);
                self::fail('Refused: '.$wrong);
            } catch (\InvalidArgumentException $exception) {
                self::assertStringContainsString('CHAT_MAX_FILE_BYTES', $exception->getMessage());
            }
        }
    }

    public function testNoFileSizeIsRefused(): void
    {
        $this->expectException(\InvalidArgumentException::class);
        new ChatMediaLimits(0);
    }

    /**
     * @return iterable<string, array{string, string}>
     */
    public static function names(): iterable
    {
        yield 'plain' => ['Drill manual.pdf', 'Drill manual.pdf'];
        yield 'a Windows path' => ['C:\\Users\\kim\\notes.txt', 'notes.txt'];
        yield 'a path upwards' => ['../../x.plist', 'x.plist'];
        yield 'a right-to-left override' => ["invoice\u{202E}fdp.exe", 'invoicefdp.exe'];
        yield 'isolates' => ["\u{2066}report\u{2069}.pdf", 'report.pdf'];
        yield 'leading dots' => ['..hidden', 'hidden'];
        yield 'nothing left' => ['..', 'file'];
    }

    #[DataProvider('names')]
    public function testAFileGoesOutUnderOnePlainName(string $given, string $sent): void
    {
        $file = new QueueReplyFile();
        $file->name = $given;

        self::assertSame($sent, $file->cleanName());
    }

    public function testTemporaryFilesOfKilledWorkersGo(): void
    {
        $dir = sys_get_temp_dir().'/tresso-sweep-test-'.bin2hex(random_bytes(4));
        mkdir($dir);
        try {
            touch($dir.'/tresso-chat-old', time() - 7200);
            touch($dir.'/tresso-chat-new', time());
            touch($dir.'/other-old', time() - 7200);

            self::assertSame(1, SweepChatMediaHandler::sweepTemporary($dir, time() - SweepChatMediaHandler::TEMPORARY_FOR));

            self::assertFileDoesNotExist($dir.'/tresso-chat-old');
            self::assertFileExists($dir.'/tresso-chat-new');
            self::assertFileExists($dir.'/other-old', 'Only upload files.');
        } finally {
            array_map('unlink', glob($dir.'/*') ?: []);
            rmdir($dir);
        }
    }
}
