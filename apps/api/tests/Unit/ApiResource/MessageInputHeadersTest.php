<?php

declare(strict_types=1);

namespace App\Tests\Unit\ApiResource;

use App\ApiResource\Input\Sync\MessageInput;
use Symfony\Bundle\FrameworkBundle\Test\KernelTestCase;
use Symfony\Component\Validator\Validator\ValidatorInterface;

final class MessageInputHeadersTest extends KernelTestCase
{
    public function testAuthenticationResultsTakesUpTo8000CharactersOtherHeaders1000(): void
    {
        self::assertCount(0, $this->violations(['authentication-results' => str_repeat('a', 8000)]));
        self::assertCount(1, $this->violations(['authentication-results' => str_repeat('a', 8001)]));
        self::assertCount(0, $this->violations(['list-id' => str_repeat('a', 1000)]));
        self::assertCount(1, $this->violations(['list-id' => str_repeat('a', 1001)]));
    }

    /**
     * @param array<string, string> $headers
     *
     * @return list<string> the property paths of the violations on headers
     */
    private function violations(array $headers): array
    {
        $input = new MessageInput();
        $input->headers = $headers;
        $validator = static::getContainer()->get(ValidatorInterface::class);
        \assert($validator instanceof ValidatorInterface);
        $paths = [];
        foreach ($validator->validate($input) as $violation) {
            if (str_starts_with($violation->getPropertyPath(), 'headers')) {
                $paths[] = $violation->getPropertyPath();
            }
        }

        return $paths;
    }
}
