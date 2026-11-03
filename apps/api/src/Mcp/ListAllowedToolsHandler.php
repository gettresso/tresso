<?php

declare(strict_types=1);

namespace App\Mcp;

use Mcp\Exception\InvalidCursorException;
use Mcp\Schema\JsonRpc\Request;
use Mcp\Schema\JsonRpc\Response;
use Mcp\Schema\Request\ListToolsRequest;
use Mcp\Schema\Result\ListToolsResult;
use Mcp\Server\Handler\Request\RequestHandlerInterface;
use Mcp\Server\Session\SessionInterface;

/**
 * Answers tools/list with only the tools the token of the request may use ({@see ToolAccess}), all on one page. Runs
 * before the SDK's own handler, which would list every registered tool. There are no further pages, so a cursor is
 * always invalid.
 *
 * @implements RequestHandlerInterface<ListToolsResult>
 */
final readonly class ListAllowedToolsHandler implements RequestHandlerInterface
{
    public function __construct(
        private ToolCatalog $catalog,
        private ToolAccess $access,
    ) {
    }

    public function supports(Request $request): bool
    {
        return $request instanceof ListToolsRequest;
    }

    /**
     * @return Response<ListToolsResult>
     */
    public function handle(Request $request, SessionInterface $session): Response
    {
        \assert($request instanceof ListToolsRequest);
        if (null !== $request->cursor) {
            throw new InvalidCursorException($request->cursor);
        }

        $tools = [];
        foreach ($this->catalog->all() as $tool) {
            if ($this->access->allows($tool)) {
                $tools[] = ToolCatalog::definition($tool);
            }
        }

        return new Response($request->getId(), new ListToolsResult($tools));
    }
}
