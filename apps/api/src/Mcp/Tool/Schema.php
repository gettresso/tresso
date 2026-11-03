<?php

declare(strict_types=1);

namespace App\Mcp\Tool;

/**
 * Small builders for the JSON Schemas of tool inputs, so every schema is written out field by field, with a
 * description a model can act on, and refuses fields it does not name.
 */
final class Schema
{
    public const string TIME_OF_DAY = '^([01][0-9]|2[0-3]):[0-5][0-9]$';
    private const string UUID = '^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}$';

    /**
     * @param array<string, array<string, mixed>> $properties
     * @param list<string>                        $required
     *
     * @return array<string, mixed>
     */
    public static function object(array $properties = [], array $required = [], ?string $description = null): array
    {
        $schema = ['type' => 'object'];
        if (null !== $description) {
            $schema['description'] = $description;
        }
        $schema['properties'] = [] === $properties ? new \stdClass() : $properties;
        if ([] !== $required) {
            $schema['required'] = $required;
        }
        $schema['additionalProperties'] = false;

        return $schema;
    }

    /**
     * @return array<string, mixed>
     */
    public static function id(string $description): array
    {
        return ['type' => 'string', 'format' => 'uuid', 'pattern' => self::UUID, 'description' => $description];
    }

    /**
     * @return array<string, mixed>
     */
    public static function string(string $description, ?int $minLength = null, ?int $maxLength = null, ?string $pattern = null): array
    {
        return array_filter([
            'type' => 'string',
            'description' => $description,
            'minLength' => $minLength,
            'maxLength' => $maxLength,
            'pattern' => $pattern,
        ], static fn (mixed $value): bool => null !== $value);
    }

    /**
     * @return array<string, mixed>
     */
    public static function timeOfDay(string $description): array
    {
        return self::string($description.' As HH:MM, 24-hour clock.', pattern: self::TIME_OF_DAY);
    }

    /**
     * @param list<string> $values
     *
     * @return array<string, mixed>
     */
    public static function enum(array $values, string $description): array
    {
        return ['type' => 'string', 'enum' => $values, 'description' => $description];
    }

    /**
     * @return array<string, mixed>
     */
    public static function boolean(string $description): array
    {
        return ['type' => 'boolean', 'description' => $description];
    }

    /**
     * @return array<string, mixed>
     */
    public static function integer(string $description, ?int $minimum = null, ?int $maximum = null): array
    {
        return array_filter([
            'type' => 'integer',
            'description' => $description,
            'minimum' => $minimum,
            'maximum' => $maximum,
        ], static fn (mixed $value): bool => null !== $value);
    }

    /**
     * @param array<string, mixed> $items
     *
     * @return array<string, mixed>
     */
    public static function list(array $items, string $description, ?int $minItems = null, ?int $maxItems = null, bool $unique = false): array
    {
        return array_filter([
            'type' => 'array',
            'description' => $description,
            'items' => $items,
            'minItems' => $minItems,
            'maxItems' => $maxItems,
            'uniqueItems' => $unique ?: null,
        ], static fn (mixed $value): bool => null !== $value);
    }

    /**
     * The same schema, also accepting null (for "clear this" or "back to the default").
     *
     * @param array<string, mixed> $schema
     *
     * @return array<string, mixed>
     */
    public static function nullable(array $schema): array
    {
        $type = $schema['type'];
        $schema['type'] = [$type, 'null'];
        if (isset($schema['enum']) && \is_array($schema['enum'])) {
            $schema['enum'][] = null;
        }

        return $schema;
    }
}
