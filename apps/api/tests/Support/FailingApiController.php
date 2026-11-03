<?php

declare(strict_types=1);

namespace App\Tests\Support;

use Symfony\Component\Routing\Attribute\Route;

/**
 * Test only (config/routes/test_support.yaml): an API path that fails with a 500 whose message holds details nobody
 * outside the server should see, so a test can show an MCP tool reports such a failure without them.
 */
final class FailingApiController
{
    public const string SECRET = 'db-internal.example:5432 password hunter2';

    #[Route('/api/v1/test-failure', name: 'test_failure', methods: ['GET'])]
    public function __invoke(): never
    {
        throw new \RuntimeException('Could not reach '.self::SECRET.'.');
    }
}
