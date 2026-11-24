<?php

declare(strict_types=1);

namespace App\Activity;

use ApiPlatform\Metadata\CollectionOperationInterface;
use ApiPlatform\Metadata\HttpOperation;
use ApiPlatform\Metadata\NotExposed;
use ApiPlatform\Metadata\Resource\Factory\ResourceMetadataCollectionFactoryInterface;
use App\Security\ChatAccessVoter;
use App\Security\Scope;
use Symfony\Component\HttpFoundation\Request;

/**
 * What the activity log keeps of an API operation a request reached: its route template (never the path with its ids,
 * never the query string), the scopes its security expression asks for, its kind, and the resource it is about with
 * the id from the path. Null for a request that reached no API operation (an address the API does not have).
 */
final readonly class ApiOperation
{
    /**
     * @param list<string> $scopes
     */
    private function __construct(
        public string $method,
        public string $route,
        public array $scopes,
        public ActivityKind $kind,
        public string $objectType,
        public bool $objectList,
        public ?string $objectId,
    ) {
    }

    public static function of(Request $request, ResourceMetadataCollectionFactoryInterface $resources): ?self
    {
        $operation = $request->attributes->get('_api_operation');
        if (!$operation instanceof HttpOperation) {
            $class = $request->attributes->get('_api_resource_class');
            $name = $request->attributes->get('_api_operation_name');
            if (!\is_string($class) || !\is_string($name)) {
                return null;
            }
            try {
                $operation = $resources->create($class)->getOperation($name);
            } catch (\Throwable) {
                return null;
            }
            if (!$operation instanceof HttpOperation) {
                return null;
            }
        }

        // API Platform's own placeholder routes (`/.well-known/genid/{id}`) always answer 404 and are no action.
        if ($operation instanceof NotExposed) {
            return null;
        }
        $template = str_replace('{._format}', '', (string) $operation->getUriTemplate());
        $route = rtrim((string) $operation->getRoutePrefix(), '/').$template;
        $method = strtoupper($operation->getMethod());
        $scopes = self::scopesOf((string) $operation->getSecurity());
        $list = $operation instanceof CollectionOperationInterface;

        // The id of what was touched: the last variable of the path, as the request named it, and the kind of thing
        // it is: the resource named by the segment before it (`/chats/{id}/outgoing` touches a chat), so an id is
        // never given the name of something else. Without an id, the operation's own resource.
        $objectId = null;
        $objectType = (string) $operation->getShortName();
        preg_match_all('#/([a-z_-]+)/\{([a-zA-Z]+)\}#', $template, $variables, \PREG_SET_ORDER);
        if ([] !== $variables) {
            [, $segment, $name] = $variables[array_key_last($variables)];
            $value = $request->attributes->get($name);
            if (\is_string($value)) {
                $objectId = $value;
                $objectType = self::resourceOf($segment);
            }
        }

        return new self(
            $method,
            $route,
            $scopes,
            self::kindOf($method, $scopes),
            $objectType,
            $list && null === $objectId,
            $objectId,
        );
    }

    /** The resource a path segment names: `smart-inboxes` is SmartInbox, `calendar-events` CalendarEvent. */
    public static function resourceOf(string $segment): string
    {
        $singular = match (true) {
            str_ends_with($segment, 'ies') => substr($segment, 0, -3).'y',
            1 === preg_match('/(x|ch|sh|ss)es$/', $segment) => substr($segment, 0, -2),
            str_ends_with($segment, 's') && !str_ends_with($segment, 'ss') => substr($segment, 0, -1),
            default => $segment,
        };

        return str_replace(' ', '', ucwords(str_replace(['-', '_'], ' ', $singular)));
    }

    /**
     * The scopes a security expression asks for: the `ROLE_OAUTH2_*` roles, and the scopes behind the chat attributes
     * for an app that is not ours.
     *
     * @return list<string>
     */
    public static function scopesOf(string $security): array
    {
        $scopes = [];
        preg_match_all('/'.preg_quote(Scope::ROLE_PREFIX, '/').'([A-Z]+:[A-Z]+)/', $security, $roles);
        foreach ($roles[1] as $role) {
            $scope = Scope::tryFrom(strtolower($role));
            if (null !== $scope) {
                $scopes[] = $scope->value;
            }
        }
        if (str_contains($security, "'".ChatAccessVoter::READ."'")) {
            $scopes[] = Scope::ChatRead->value;
        }
        if (str_contains($security, "'".ChatAccessVoter::SEND."'")) {
            $scopes[] = Scope::ChatSend->value;
        }

        return array_values(array_unique($scopes));
    }

    /**
     * Read for GET and HEAD; Send for a write that needs `mail:send` or `chat:send` (it sends mail or a WhatsApp
     * message); Change for any other write.
     *
     * @param list<string> $scopes
     */
    public static function kindOf(string $method, array $scopes): ActivityKind
    {
        if (\in_array($method, ['GET', 'HEAD'], true)) {
            return ActivityKind::Read;
        }

        return [] !== array_intersect($scopes, [Scope::MailSend->value, Scope::ChatSend->value]) ? ActivityKind::Send : ActivityKind::Change;
    }
}
