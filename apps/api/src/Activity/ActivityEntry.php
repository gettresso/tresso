<?php

declare(strict_types=1);

namespace App\Activity;

use App\Entity\AppActivity;
use App\Security\Scope;
use Symfony\Component\Uid\Uuid;

/**
 * An entry of the activity log on its way to the database ({@see ActivityLog}). It checks that every field has the
 * shape of what the log may keep, so no message text, argument, query string or concrete path can get in by mistake:
 * the action is a tool name or a route template, the object a resource name and an id.
 */
final readonly class ActivityEntry
{
    /**
     * A tool name (`get_mail_account`) or a route template (`/api/v1/mail-accounts/{id}`), nothing else. No literal
     * segment of an API route has a digit, and every id has one (a UUID always has its version digit), so a concrete
     * path never passes for a template.
     */
    private const string ACTION = '#^([a-z]+(_[a-z]+)+|/api/v1(/([a-z_-]+|\{[a-zA-Z]+\}))+)$#';
    private const string METHOD = '/^(GET|HEAD|POST|PUT|PATCH|DELETE)$/';
    private const string OBJECT_TYPE = '/^[A-Z][A-Za-z]{0,63}$/';
    private const string OBJECT_ID = '/^[A-Za-z0-9._-]{1,100}$/';

    public ?string $objectType;
    public ?string $objectId;

    /**
     * @param list<string> $scopes the values of the scopes the action needed
     */
    public function __construct(
        public Uuid $owner,
        public \DateTimeImmutable $occurredAt,
        public ActivityApp $app,
        public ActivityChannel $channel,
        public ?string $method,
        public string $action,
        public ActivityKind $kind,
        public ?ActivityReason $reason,
        public int $durationMs,
        public array $scopes,
        ?string $objectType = null,
        public bool $objectList = false,
        ?string $objectId = null,
    ) {
        if (1 !== preg_match(self::ACTION, $action) || \strlen($action) > AppActivity::ACTION_MAX_LENGTH) {
            throw new \InvalidArgumentException('An activity action is a tool name or a route template.');
        }
        if ((ActivityChannel::Api === $channel) !== (null !== $method) || (null !== $method && 1 !== preg_match(self::METHOD, $method))) {
            throw new \InvalidArgumentException('An API request has its method; a tool call has none.');
        }
        foreach ($scopes as $scope) {
            if (null === Scope::tryFrom($scope)) {
                throw new \InvalidArgumentException(\sprintf('"%s" is not a scope.', $scope));
            }
        }
        // What does not have the shape of a resource name or an id is left out, not refused: the action is still logged.
        $this->objectType = null !== $objectType && 1 === preg_match(self::OBJECT_TYPE, $objectType) ? $objectType : null;
        $this->objectId = null !== $this->objectType && null !== $objectId && 1 === preg_match(self::OBJECT_ID, $objectId) ? $objectId : null;
    }

    public function result(): ActivityResult
    {
        return $this->reason?->result() ?? ActivityResult::Done;
    }
}
