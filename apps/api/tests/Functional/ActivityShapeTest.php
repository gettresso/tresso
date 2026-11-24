<?php

declare(strict_types=1);

namespace App\Tests\Functional;

use ApiPlatform\Metadata\NotExposed;
use ApiPlatform\Metadata\Resource\Factory\ResourceMetadataCollectionFactoryInterface;
use ApiPlatform\Metadata\Resource\Factory\ResourceNameCollectionFactoryInterface;
use App\Activity\ActivityApp;
use App\Activity\ActivityChannel;
use App\Activity\ActivityEntry;
use App\Activity\ActivityKind;
use App\Activity\ApiOperation;
use App\Mcp\ToolCatalog;
use Symfony\Bundle\FrameworkBundle\Test\KernelTestCase;
use Symfony\Component\Uid\Uuid;

/**
 * Every API route (but API Platform's own placeholders, which the log skips) and every MCP tool fits the shape the activity log keeps, so no operation or tool added later can go
 * unlogged without this test failing.
 */
final class ActivityShapeTest extends KernelTestCase
{
    public function testEveryApiRouteTemplateFitsTheLog(): void
    {
        $container = static::getContainer();
        $names = $container->get(ResourceNameCollectionFactoryInterface::class);
        $resources = $container->get(ResourceMetadataCollectionFactoryInterface::class);
        $checked = 0;
        $refused = [];
        foreach ($names->create() as $class) {
            foreach ($resources->create($class) as $resource) {
                foreach ($resource->getOperations() ?? [] as $operation) {
                    if ($operation instanceof NotExposed || '/api/v1' !== $operation->getRoutePrefix()) {
                        continue;
                    }
                    $route = '/api/v1'.str_replace('{._format}', '', (string) $operation->getUriTemplate());
                    $scopes = ApiOperation::scopesOf((string) $operation->getSecurity());
                    try {
                        new ActivityEntry(Uuid::v7(), new \DateTimeImmutable(), ActivityApp::client('claude'), ActivityChannel::Api, strtoupper($operation->getMethod()), $route, ApiOperation::kindOf(strtoupper($operation->getMethod()), $scopes), null, 1, $scopes, $operation->getShortName());
                    } catch (\InvalidArgumentException) {
                        $refused[] = $operation->getMethod().' '.$route;
                    }
                    ++$checked;
                }
            }
        }

        self::assertSame([], $refused);
        self::assertGreaterThan(100, $checked, 'Every operation of the API was checked.');
    }

    public function testEveryToolNameFitsTheLog(): void
    {
        $tools = static::getContainer()->get(ToolCatalog::class)->all();
        foreach ($tools as $tool) {
            new ActivityEntry(Uuid::v7(), new \DateTimeImmutable(), ActivityApp::client('claude'), ActivityChannel::Mcp, null, $tool->name, ActivityKind::ofTool($tool->effect), null, 1, array_map(static fn ($scope): string => $scope->value, $tool->scopes));
        }

        self::assertGreaterThan(30, \count($tools));
    }
}
