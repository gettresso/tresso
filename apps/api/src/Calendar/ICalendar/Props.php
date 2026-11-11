<?php

declare(strict_types=1);

namespace App\Calendar\ICalendar;

use Sabre\VObject\Component;
use Sabre\VObject\Property;
use Sabre\VObject\Property\ICalendar\DateTime as DateTimeProperty;

/**
 * Typed access to sabre/vobject components, whose properties are otherwise magic and untyped.
 */
final class Props
{
    /** The longest UID stored: the uid columns of calendar objects, event rows and invitations hold this many. */
    public const int MAX_UID_LENGTH = 1024;
    /** SEQUENCE is stored in a 32-bit column; RFC 5545 gives it no bound, so larger values count as this. */
    public const int MAX_SEQUENCE = 2147483647;

    public static function get(Component $component, string $name): ?Property
    {
        foreach ($component->select($name) as $child) {
            if ($child instanceof Property) {
                return $child;
            }
        }

        return null;
    }

    /**
     * @return list<Property>
     */
    public static function all(Component $component, string $name): array
    {
        return array_values(array_filter($component->select($name), static fn (mixed $child): bool => $child instanceof Property));
    }

    /**
     * @return list<Component>
     */
    public static function components(Component $component, string $name): array
    {
        return array_values(array_filter($component->select($name), static fn (mixed $child): bool => $child instanceof Component));
    }

    public static function dateTime(Component $component, string $name): ?DateTimeProperty
    {
        $property = self::get($component, $name);

        return $property instanceof DateTimeProperty ? $property : null;
    }

    /**
     * @return list<DateTimeProperty>
     */
    public static function dateTimes(Component $component, string $name): array
    {
        return array_values(array_filter(self::all($component, $name), static fn (Property $property): bool => $property instanceof DateTimeProperty));
    }

    /** The trimmed text value, or null when the property is missing or empty. */
    public static function text(Component $component, string $name): ?string
    {
        $property = self::get($component, $name);
        if (null === $property) {
            return null;
        }
        $value = trim(self::value($property));

        return '' === $value ? null : $value;
    }

    public static function int(Component $component, string $name): int
    {
        $value = self::text($component, $name);

        return null !== $value && is_numeric($value) ? (int) $value : 0;
    }

    /** SEQUENCE, between 0 and what the database stores. */
    public static function sequence(Component $component): int
    {
        return max(0, min(self::int($component, 'SEQUENCE'), self::MAX_SEQUENCE));
    }

    public static function value(Property $property): string
    {
        // Integer and other typed values come back as such, whatever the docblock says.
        /** @var mixed $value */
        $value = $property->getValue();

        return \is_scalar($value) ? (string) $value : '';
    }

    public static function param(Property $property, string $name): ?string
    {
        $parameter = $property[$name];
        if (!$parameter instanceof \Sabre\VObject\Parameter) {
            return null;
        }
        $value = trim((string) $parameter, " \t\"");

        return '' === $value ? null : $value;
    }

    /** Replaces every property of that name with one value. */
    public static function set(Component $component, string $name, mixed $value): void
    {
        $component->remove($name);
        $component->add($name, $value);
    }

    /** A mailto: href or bare address as a lower case address. */
    public static function address(string $href): string
    {
        $href = trim($href);

        return mb_strtolower(str_starts_with(strtolower($href), 'mailto:') ? substr($href, 7) : $href);
    }

    public static function uid(Component $component): string
    {
        return self::text($component, 'UID') ?? '';
    }
}
