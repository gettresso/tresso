<?php

declare(strict_types=1);

namespace App\Mcp;

use Symfony\Component\HttpFoundation\Request;
use Symfony\Component\HttpFoundation\RequestStack;
use Symfony\Component\HttpFoundation\Response;
use Symfony\Component\HttpKernel\HttpKernelInterface;

/**
 * Runs the API operation an MCP tool stands for, as a sub-request of the MCP request: the same security token, so the
 * same scopes, voters, first-party checks, providers, validation and error messages as the REST call, and no way for a
 * tool to do what the API would not do with that token. The firewall does not run again (it only guards the main
 * request, which it already signed in); the sub-request carries the same `Authorization` header for code that reads it.
 *
 * Answers with the decoded JSON body (an empty array for 204). A 4xx becomes an {@see ApiRefusal} with the API's
 * message and violations; a 5xx is a failure of ours and is thrown as such.
 */
final readonly class Api
{
    public const string PREFIX = '/api/v1';

    private const string JSON = 'application/json';
    private const string MERGE_PATCH = 'application/merge-patch+json';

    public function __construct(
        private HttpKernelInterface $httpKernel,
        private RequestStack $requestStack,
    ) {
    }

    /**
     * @param array<string, scalar> $query
     *
     * @return array<mixed>
     */
    public function get(string $path, array $query = []): array
    {
        return $this->send(Request::METHOD_GET, $path, $query, null);
    }

    /**
     * @param array<string, mixed> $body
     *
     * @return array<mixed>
     */
    public function post(string $path, array $body): array
    {
        return $this->send(Request::METHOD_POST, $path, [], $body);
    }

    /**
     * A JSON merge patch: only the fields in $body change.
     *
     * @param array<string, mixed> $body
     *
     * @return array<mixed>
     */
    public function patch(string $path, array $body): array
    {
        return $this->send(Request::METHOD_PATCH, $path, [], $body);
    }

    /**
     * @param array<string, mixed> $body
     *
     * @return array<mixed>
     */
    public function put(string $path, array $body): array
    {
        return $this->send(Request::METHOD_PUT, $path, [], $body);
    }

    /**
     * @return array<mixed>
     */
    public function delete(string $path): array
    {
        return $this->send(Request::METHOD_DELETE, $path, [], null);
    }

    /**
     * @param array<string, scalar>     $query
     * @param array<string, mixed>|null $body
     *
     * @return array<mixed>
     */
    private function send(string $method, string $path, array $query, ?array $body): array
    {
        // Paths are written by the tools, with ids checked by ToolArguments::id(); never a way out of the API.
        if (1 !== preg_match('#^(/[a-z0-9-]+)+$#', $path)) {
            throw new \LogicException(\sprintf('"%s" is not an API path an MCP tool may call.', $path));
        }

        $main = $this->requestStack->getMainRequest();
        if (null === $main) {
            throw new \LogicException('An MCP tool runs inside an MCP request.');
        }

        $server = [
            'HTTP_ACCEPT' => self::JSON,
            'HTTP_HOST' => $main->getHttpHost(),
            'HTTPS' => $main->isSecure() ? 'on' : 'off',
            'REMOTE_ADDR' => $main->server->get('REMOTE_ADDR', '127.0.0.1'),
        ];
        $authorization = $main->headers->get('Authorization');
        if (null !== $authorization) {
            $server['HTTP_AUTHORIZATION'] = $authorization;
        }

        $content = null;
        if (null !== $body) {
            $server['CONTENT_TYPE'] = Request::METHOD_PATCH === $method ? self::MERGE_PATCH : self::JSON;
            // An empty body is an empty object, never a JSON list.
            $content = [] === $body ? '{}' : json_encode($body, \JSON_THROW_ON_ERROR | \JSON_PRESERVE_ZERO_FRACTION);
        }

        $request = Request::create(self::PREFIX.$path, $method, $query, [], [], $server, $content);

        return self::decode($method, $path, $this->httpKernel->handle($request, HttpKernelInterface::SUB_REQUEST));
    }

    /**
     * @return array<mixed>
     */
    private static function decode(string $method, string $path, Response $response): array
    {
        $status = $response->getStatusCode();
        if ($status >= 500) {
            throw new \RuntimeException(\sprintf('The API answered %d to %s %s for an MCP tool.', $status, $method, $path));
        }

        $raw = Response::HTTP_NO_CONTENT === $status ? '' : (string) $response->getContent();
        $data = '' === $raw ? [] : json_decode($raw, true);
        if (!\is_array($data)) {
            if ($status < 400) {
                throw new \RuntimeException(\sprintf('The API answered %s %s for an MCP tool with something other than JSON.', $method, $path));
            }
            $data = [];
        }

        if ($status < 400) {
            return $data;
        }

        $violations = [];
        foreach (\is_array($data['violations'] ?? null) ? $data['violations'] : [] as $violation) {
            if (!\is_array($violation) || !\is_string($violation['message'] ?? null)) {
                continue;
            }
            $violations[] = [
                'field' => \is_string($violation['propertyPath'] ?? null) ? $violation['propertyPath'] : '',
                'message' => $violation['message'],
            ];
        }

        $detail = $data['detail'] ?? $data['title'] ?? null;

        throw new ApiRefusal($status, \is_string($detail) && '' !== $detail ? $detail : (Response::$statusTexts[$status] ?? 'Refused.'), $violations);
    }
}
