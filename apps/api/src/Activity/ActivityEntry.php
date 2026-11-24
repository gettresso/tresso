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

    public ?string $objectType;
    public ?string $objectId;

    /** @var list<string> */
    public array $missingScopes;

    /**
     * @param list<string> $scopes        the values of the scopes the action needed
     * @param list<string> $missingScopes for a refusal for want of a permission: those the app lacked then
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
        array $missingScopes = [],
    ) {
        if (1 !== preg_match(self::ACTION, $action) || \strlen($action) > AppActivity::ACTION_MAX_LENGTH) {
            throw new \InvalidArgumentException('An activity action is a tool name or a route template.');
        }
        if ((ActivityChannel::Api === $channel) !== (null !== $method) || (null !== $method && 1 !== preg_match(self::METHOD, $method))) {
            throw new \InvalidArgumentException('An API request has its method; a tool call has none.');
        }
        foreach ([...$scopes, ...$missingScopes] as $scope) {
            if (null === Scope::tryFrom($scope)) {
                throw new \InvalidArgumentException(\sprintf('"%s" is not a scope.', $scope));
            }
        }
        $this->missingScopes = ActivityReason::NoPermission === $reason ? array_values(array_intersect($missingScopes, $scopes)) : [];
        // What does not have the shape of a resource name is left out, not refused: the action is still logged. The id
        // is kept only when it is a UUID, the only kind of id the API hands out: any other path text is the caller's
        // own (`/smart-inboxes/call-0800-123456`) and must not show up in the user's log as if Tresso said it.
        $this->objectType = null !== $objectType && 1 === preg_match(self::OBJECT_TYPE, $objectType) ? $objectType : null;
        $this->objectId = null !== $this->objectType && null !== $objectId && Uuid::isValid($objectId) ? Uuid::fromString($objectId)->toRfc4122() : null;
    }

    public function result(): ActivityResult
    {
        return $this->reason?->result() ?? ActivityResult::Done;
    }

    /**
     * What makes repeats one entry: the same owner, app, way in, action, result and reason within a minute; within an
     * hour for a refused token (expired or revoked), which a script may keep sending for days.
     */
    public function repeatKey(): string
    {
        $hourly = \in_array($this->reason, [ActivityReason::TokenExpired, ActivityReason::AccessRevoked], true);

        return hash('sha256', implode('|', [
            $this->owner->toRfc4122(),
            $this->app->key(),
            $this->channel->value,
            $this->method ?? '',
            $this->action,
            $this->result()->value,
            null === $this->reason ? '' : $this->reason->value,
            $this->occurredAt->format($hourly ? 'Y-m-d H' : 'Y-m-d H:i'),
        ]));
    }
}
