<?php

declare(strict_types=1);

namespace App\Tests\Functional;

use Symfony\Bundle\FrameworkBundle\Console\Application;
use Symfony\Bundle\FrameworkBundle\Test\KernelTestCase;
use Symfony\Component\Console\Tester\CommandTester;

final class CheckProductionSettingsCommandTest extends KernelTestCase
{
    public function testRefusesTheRepositorysDevelopmentSettings(): void
    {
        $tester = new CommandTester(new Application(self::bootKernel())->find('app:settings:check'));

        $tester->execute([]);

        self::assertSame(1, $tester->getStatusCode());
        $output = preg_replace('/\s+/', ' ', $tester->getDisplay());
        self::assertIsString($output);
        self::assertStringContainsString('DATA_KEYS is still the development key', $output);
        self::assertStringContainsString('OAUTH_PASSPHRASE is still a development or example value', $output);
        self::assertStringNotContainsString('BAlSUjZIooXa8NYJsDBsKuMkgeoFrfxeKgrNTqBRESY', $output, 'No secret is printed.');
    }
}
