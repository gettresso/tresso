<?php

declare(strict_types=1);

namespace App\Mcp\Tool;

use Mcp\Exception\ToolCallException;
use Symfony\Component\Uid\Uuid;

/**
 * The arguments of a tool call, already checked against the tool's input schema by the SDK (which refuses unknown
 * fields, since every schema sets `additionalProperties: false`).
 */
final readonly class ToolArguments
{
    /**
     * @param array<string, mixed> $arguments
     */
    public function __construct(private array $arguments)
    {
    }

    public function has(string $name): bool
    {
        return \array_key_exists($name, $this->arguments);
    }

    public function get(string $name): mixed
    {
        return $this->arguments[$name] ?? null;
    }

    /**
     * An id for a URL path: a UUID, written the way the API writes it.
     *
     * @throws ToolCallException when it is missing or not a UUID
     */
    public function id(string $name): string
    {
        $value = $this->arguments[$name] ?? null;
        if (!\is_string($value) || !Uuid::isValid($value)) {
            throw new ToolCallException(\sprintf('"%s" must be an id (a UUID) from one of the list_ tools.', $name));
        }

        return Uuid::fromString($value)->toRfc4122();
    }

    /**
     * @throws ToolCallException when it is missing or not a string
     */
    public function string(string $name): string
    {
        $value = $this->arguments[$name] ?? null;
        if (!\is_string($value)) {
            throw new ToolCallException(\sprintf('"%s" is required.', $name));
        }

        return $value;
    }

    /**
     * @return list<string>
     *
     * @throws ToolCallException when it is missing or not a list of strings
     */
    public function strings(string $name): array
    {
        $value = $this->arguments[$name] ?? null;
        if (!\is_array($value) || !array_is_list($value)) {
            throw new ToolCallException(\sprintf('"%s" must be a list.', $name));
        }

        return array_values(array_filter($value, \is_string(...)));
    }

    /**
     * The given arguments among $names, for a request body: what the caller left out is left out.
     *
     * @param list<string> $names
     *
     * @return array<string, mixed>
     */
    public function only(array $names): array
    {
        return array_intersect_key($this->arguments, array_flip($names));
    }
}
