<?php

declare(strict_types=1);

namespace App\Entity;

use App\Activity\ActivityApp;
use App\Activity\ActivityChannel;
use App\Activity\ActivityKind;
use App\Activity\ActivityReason;
use App\Activity\ActivityResult;
use App\Repository\AppActivityRepository;
use Doctrine\DBAL\Types\Types;
use Doctrine\ORM\Mapping as ORM;
use Symfony\Bridge\Doctrine\Types\UuidType;
use Symfony\Component\Uid\Uuid;

/**
 * One action an app that is not ours (an OAuth client or a personal access token) took for a user: an MCP tool call or
 * an API request. It holds what happened and never what it was about: the app by id, how it came in, the tool name or
 * the method and route template, the kind, the result with a reason, the duration, the scopes the action needed and
 * the kind and id of the object it touched. Never message text, subjects, file names, search words, addresses of other
 * people, request or response bodies, query strings, concrete paths or tool arguments.
 *
 * Written by {@see \App\Activity\ActivityLog} after the response was sent; removed after {@see KEEP_FOR} by
 * {@see \App\Activity\PurgeAppActivityHandler}, and with the user (foreign key cascade).
 */
#[ORM\Entity(repositoryClass: AppActivityRepository::class, readOnly: true)]
#[ORM\Table(name: 'app_activity')]
#[ORM\Index(name: 'app_activity_owner_time', columns: ['owner_id', 'occurred_at', 'id'])]
#[ORM\Index(name: 'app_activity_owner_app_time', columns: ['owner_id', 'app_type', 'app_id', 'occurred_at'])]
#[ORM\Index(name: 'app_activity_owner_kind_time', columns: ['owner_id', 'kind', 'occurred_at'])]
#[ORM\Index(name: 'app_activity_owner_result_time', columns: ['owner_id', 'result', 'occurred_at'])]
#[ORM\Index(name: 'app_activity_time', columns: ['occurred_at'])]
class AppActivity
{
    public const string KEEP_FOR = 'P90D';
    public const int KEEP_FOR_DAYS = 90;
    public const int ACTION_MAX_LENGTH = 200;
    public const int OBJECT_TYPE_MAX_LENGTH = 64;
    public const int OBJECT_ID_MAX_LENGTH = 100;

    #[ORM\Id]
    #[ORM\Column(type: UuidType::NAME)]
    private Uuid $id;

    #[ORM\ManyToOne]
    #[ORM\JoinColumn(nullable: false, onDelete: 'CASCADE')]
    private User $owner;

    /** When the action started. */
    #[ORM\Column(type: Types::DATETIME_IMMUTABLE)]
    private \DateTimeImmutable $occurredAt;

    /** {@see ActivityApp::CLIENT} or {@see ActivityApp::TOKEN}. */
    #[ORM\Column(length: 8)]
    private string $appType;

    /** The OAuth client id or the personal access token id. */
    #[ORM\Column(length: 80)]
    private string $appId;

    #[ORM\Column(length: 8, enumType: ActivityChannel::class)]
    private ActivityChannel $channel;

    /** The HTTP method of an API request; null for a tool call. */
    #[ORM\Column(length: 8, nullable: true)]
    private ?string $method;

    /** The tool name, or the route template of an API request (`/api/v1/mail-accounts/{id}`). */
    #[ORM\Column(length: self::ACTION_MAX_LENGTH)]
    private string $action;

    #[ORM\Column(length: 8, enumType: ActivityKind::class)]
    private ActivityKind $kind;

    #[ORM\Column(length: 8, enumType: ActivityResult::class)]
    private ActivityResult $result;

    #[ORM\Column(length: 32, nullable: true, enumType: ActivityReason::class)]
    private ?ActivityReason $reason;

    #[ORM\Column]
    private int $durationMs;

    /**
     * The scopes the action needed, by their value.
     *
     * @var list<string>
     */
    #[ORM\Column(type: Types::JSON)]
    private array $scopes;

    /** The kind of what was touched: the API resource (`MailAccount`), or null when nothing was reached. */
    #[ORM\Column(length: self::OBJECT_TYPE_MAX_LENGTH, nullable: true)]
    private ?string $objectType;

    /** Whether the action was on a list of them rather than one. */
    #[ORM\Column(options: ['default' => false])]
    private bool $objectList;

    /** The id of what was touched; null for a list without a parent, or when nothing was reached. */
    #[ORM\Column(length: self::OBJECT_ID_MAX_LENGTH, nullable: true)]
    private ?string $objectId;

    /**
     * @param list<string> $scopes
     */
    public function __construct(
        Uuid $id,
        User $owner,
        \DateTimeImmutable $occurredAt,
        ActivityApp $app,
        ActivityChannel $channel,
        ?string $method,
        string $action,
        ActivityKind $kind,
        ActivityResult $result,
        ?ActivityReason $reason,
        int $durationMs,
        array $scopes,
        ?string $objectType,
        bool $objectList,
        ?string $objectId,
    ) {
        $this->id = $id;
        $this->owner = $owner;
        $this->occurredAt = $occurredAt;
        $this->appType = $app->type;
        $this->appId = $app->id;
        $this->channel = $channel;
        $this->method = $method;
        $this->action = $action;
        $this->kind = $kind;
        $this->result = $result;
        $this->reason = $reason;
        $this->durationMs = $durationMs;
        $this->scopes = $scopes;
        $this->objectType = $objectType;
        $this->objectList = $objectList;
        $this->objectId = $objectId;
    }

    public function getId(): Uuid
    {
        return $this->id;
    }

    public function getOwner(): User
    {
        return $this->owner;
    }

    public function getOccurredAt(): \DateTimeImmutable
    {
        return $this->occurredAt;
    }

    public function getApp(): ActivityApp
    {
        return ActivityApp::TOKEN === $this->appType ? ActivityApp::token($this->appId) : ActivityApp::client(rtrim($this->appId));
    }

    public function getChannel(): ActivityChannel
    {
        return $this->channel;
    }

    public function getMethod(): ?string
    {
        return $this->method;
    }

    public function getAction(): string
    {
        return $this->action;
    }

    public function getKind(): ActivityKind
    {
        return $this->kind;
    }

    public function getResult(): ActivityResult
    {
        return $this->result;
    }

    public function getReason(): ?ActivityReason
    {
        return $this->reason;
    }

    public function getDurationMs(): int
    {
        return $this->durationMs;
    }

    /** @return list<string> */
    public function getScopes(): array
    {
        return $this->scopes;
    }

    public function getObjectType(): ?string
    {
        return $this->objectType;
    }

    public function isObjectList(): bool
    {
        return $this->objectList;
    }

    public function getObjectId(): ?string
    {
        return $this->objectId;
    }
}
