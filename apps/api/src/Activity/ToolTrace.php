<?php

declare(strict_types=1);

namespace App\Activity;

use ApiPlatform\Metadata\Resource\Factory\ResourceMetadataCollectionFactoryInterface;
use Symfony\Component\HttpFoundation\Request;
use Symfony\Component\HttpFoundation\Response;
use Symfony\Contracts\Service\ResetInterface;

/**
 * The API operations an MCP tool ran while it ran ({@see \App\Mcp\Api} reports each sub-request), so its entry in the
 * activity log can name what it touched: the last operation that names an object by id, else the last one. A tool that
 * first checks something (the WhatsApp tools read the status first) and then acts is logged with what it acted on.
 */
final class ToolTrace implements ResetInterface
{
    private bool $active = false;
    private ?ApiOperation $last = null;
    private ?ApiOperation $lastWithId = null;

    public function __construct(private readonly ResourceMetadataCollectionFactoryInterface $resources)
    {
    }

    public function start(): void
    {
        $this->active = true;
        $this->last = $this->lastWithId = null;
    }

    public function saw(Request $subRequest, ?Response $response = null): void
    {
        if (!$this->active) {
            return;
        }
        $operation = ApiOperation::of($subRequest, $this->resources, $response);
        if (null === $operation) {
            return;
        }
        $this->last = $operation;
        if (null !== $operation->objectId) {
            $this->lastWithId = $operation;
        }
    }

    /** What the tool touched, and stops tracing. */
    public function stop(): ?ApiOperation
    {
        $touched = $this->lastWithId ?? $this->last;
        $this->reset();

        return $touched;
    }

    public function reset(): void
    {
        $this->active = false;
        $this->last = $this->lastWithId = null;
    }
}
