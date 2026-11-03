<?php

declare(strict_types=1);

namespace App\Tests\Unit;

use App\Security\Scope;
use PHPUnit\Framework\TestCase;

/**
 * The web client offers the scopes in packages/core (PERSONAL_ACCESS_TOKEN_SCOPES); they must be exactly the ones the
 * API accepts for a personal access token. Needs the whole repository: in the dev container only apps/api is mounted,
 * so it is skipped there and runs in CI.
 */
final class PersonalAccessTokenScopesMatchCoreTest extends TestCase
{
    private const string CORE = '/packages/core';
    private const string FILE = '/packages/core/src/personalAccessTokens.ts';

    public function testCoreOffersExactlyTheScopesTheApiAccepts(): void
    {
        $root = \dirname(__DIR__, 4);
        if (!is_dir($root.self::CORE)) {
            self::markTestSkipped('packages/core is not next to apps/api here (the dev container mounts apps/api only).');
        }

        $source = file_get_contents($root.self::FILE);
        self::assertIsString($source, 'packages/core/src/personalAccessTokens.ts is missing.');
        if (1 !== preg_match('/export const PERSONAL_ACCESS_TOKEN_SCOPES\b[^=]*=\s*\[(.*?)\n\]/s', $source, $list)) {
            self::fail('PERSONAL_ACCESS_TOKEN_SCOPES not found in packages/core/src/personalAccessTokens.ts.');
        }
        preg_match_all("/\\bvalue:\\s*'([^']+)'/", $list[1], $values);

        $offered = $values[1];
        $accepted = array_map(static fn (Scope $scope): string => $scope->value, Scope::personalAccessTokenScopes());
        self::assertCount(\count(array_unique($offered)), $offered, 'A scope is offered twice.');
        sort($offered);
        sort($accepted);
        self::assertSame($accepted, $offered);
    }
}
