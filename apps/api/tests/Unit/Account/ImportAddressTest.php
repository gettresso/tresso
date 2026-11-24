<?php

declare(strict_types=1);

namespace App\Tests\Unit\Account;

use App\Account\Import\ImportAddress;
use App\Enum\ImportFailure;
use App\ProviderAuth\ConnectError;
use PHPUnit\Framework\Attributes\DataProvider;
use PHPUnit\Framework\TestCase;

/**
 * What counts as an address of an import list. The cases are shared with packages/core (readPastedAddresses), so the
 * paste step and the API agree on what they leave out.
 */
final class ImportAddressTest extends TestCase
{
    private const string FIXTURE = __DIR__.'/../../Fixtures/import-addresses.json';

    /**
     * @return iterable<string, array{string, ?string, ?string}>
     */
    public static function cases(): iterable
    {
        $data = json_decode((string) file_get_contents(self::FIXTURE), true, flags: \JSON_THROW_ON_ERROR);
        self::assertIsArray($data);
        self::assertIsArray($data['cases'] ?? null);
        foreach ($data['cases'] as $index => $case) {
            self::assertIsArray($case);
            $input = $case['input'] ?? null;
            self::assertIsString($input);
            $firstParty = $case['firstParty'] ?? null;
            $thirdParty = $case['thirdParty'] ?? null;
            yield \sprintf('%d: %s', $index, mb_substr($input, 0, 40)) => [$input, \is_string($firstParty) ? $firstParty : null, \is_string($thirdParty) ? $thirdParty : null];
        }
    }

    #[DataProvider('cases')]
    public function testTheSharedCases(string $input, ?string $firstParty, ?string $thirdParty): void
    {
        self::assertSame($firstParty, ImportAddress::normalize($input, true), 'A list made in Tresso.');
        self::assertSame($thirdParty, ImportAddress::normalize($input, false), 'A list an app or a token made.');
    }

    public function testEveryProviderFailureHasAReasonOnTheRow(): void
    {
        foreach (ConnectError::cases() as $error) {
            self::assertSame($error->value, ImportFailure::fromConnectError($error)->value, $error->name);
        }
    }
}
