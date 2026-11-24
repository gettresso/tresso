<?php

declare(strict_types=1);

namespace App\Activity;

use App\Entity\AppActivity;
use App\Entity\User;
use App\Mcp\ToolCatalog;
use App\Security\Scope;
use Doctrine\DBAL\ArrayParameterType;
use Doctrine\DBAL\Connection;

/**
 * Describes entries of the activity log for the user who reads it, with what is true when it is read: the app's name
 * (null once the app or token is gone), whether the app still holds each permission the action needed, the tool's
 * title or a title for the API route, the kind of what was touched in words, and for a refusal or failure the reason in
 * a sentence.
 */
final readonly class ActivityDescriber
{
    /**
     * Words for the API resources an entry can name: singular and plural. Any other resource is named after itself
     * ("CalendarEvent" is "Calendar event").
     */
    private const array OBJECTS = [
        'Chat' => ['WhatsApp chat', 'WhatsApp chats'],
        'ChatList' => ['WhatsApp chat', 'WhatsApp chats'],
        'ChatTimeline' => ['WhatsApp chat', 'WhatsApp chats'],
        'ChatSearch' => ['WhatsApp chat', 'WhatsApp chats'],
        'ChatAccount' => ['WhatsApp connection', 'WhatsApp connections'],
        'ChatStatus' => ['WhatsApp status', 'WhatsApp status'],
        'ChatOutgoing' => ['WhatsApp message', 'WhatsApp messages'],
        'ChatMedia' => ['WhatsApp file', 'WhatsApp files'],
        'ChatMediaContent' => ['WhatsApp file', 'WhatsApp files'],
        'ChatFileContent' => ['WhatsApp file', 'WhatsApp files'],
        'ChatUpload' => ['WhatsApp file', 'WhatsApp files'],
        'SmartInboxSenders' => ['Smart inbox', 'Smart inboxes'],
        'CalendarOccurrence' => ['Calendar event', 'Calendar events'],
        'MessageBody' => ['Message', 'Messages'],
        'AttachmentContent' => ['Attachment', 'Attachments'],
        'DraftAttachmentContent' => ['Draft attachment', 'Draft attachments'],
        'Me' => ['Your account', 'Your account'],
        'ServerInfo' => ['Server information', 'Server information'],
    ];

    public function __construct(
        private Connection $connection,
        private ToolCatalog $tools,
    ) {
    }

    /**
     * @param list<AppActivity> $entries
     *
     * @return list<array<string, mixed>>
     */
    public function describe(User $reader, array $entries): array
    {
        $apps = $this->apps($reader, array_map(static fn (AppActivity $entry): ActivityApp => $entry->getApp(), $entries));

        return array_map(fn (AppActivity $entry): array => $this->entry($entry, $apps[$entry->getApp()->key()]), $entries);
    }

    /**
     * The apps by key, with their names, for the app filter, sorted by name.
     *
     * @param list<ActivityApp> $apps
     *
     * @return list<array{key: string, type: string, name: string|null}>
     */
    public function appList(User $reader, array $apps): array
    {
        $list = array_values(array_map(
            static fn (array $app): array => ['key' => $app['key'], 'type' => $app['type'], 'name' => $app['name']],
            $this->apps($reader, $apps),
        ));
        usort($list, static fn (array $a, array $b): int => [null === $a['name'], mb_strtolower($a['name'] ?? ''), $a['key']] <=> [null === $b['name'], mb_strtolower($b['name'] ?? ''), $b['key']]);

        return $list;
    }

    /**
     * @param array{key: string, type: string, name: string|null, connectedAppId: string|null, personalAccessTokenId: string|null, held: list<string>} $app
     *
     * @return array<string, mixed>
     */
    private function entry(AppActivity $entry, array $app): array
    {
        $reason = $entry->getReason();
        $objectType = $entry->getObjectType();

        return [
            'id' => $entry->getId()->toRfc4122(),
            'occurredAt' => $entry->getOccurredAt()->format(\DATE_ATOM),
            'app' => [
                'key' => $app['key'],
                'type' => $app['type'],
                'name' => $app['name'],
                'connectedAppId' => $app['connectedAppId'],
                'personalAccessTokenId' => $app['personalAccessTokenId'],
            ],
            'channel' => $entry->getChannel()->value,
            'action' => [
                'name' => null === $entry->getMethod() ? $entry->getAction() : $entry->getMethod().' '.$entry->getAction(),
                'title' => $this->title($entry),
            ],
            'kind' => $entry->getKind()->value,
            'result' => $entry->getResult()->value,
            'reason' => null === $reason ? null : [
                'code' => $reason->value,
                'label' => $reason->label(),
                'sentence' => $this->sentence($entry, $reason, $app),
            ],
            'durationMs' => $entry->getDurationMs(),
            'permissions' => array_map(static fn (string $value): array => [
                'scope' => $value,
                'label' => self::scopeLabel($value),
                'held' => \in_array($value, $app['held'], true),
            ], $entry->getScopes()),
            'count' => $entry->getCount(),
            'lastOccurredAt' => $entry->getLastOccurredAt()->format(\DATE_ATOM),
            'object' => null === $objectType ? null : [
                'type' => $objectType,
                'label' => self::objectLabel($objectType, $entry->isObjectList()),
                'list' => $entry->isObjectList(),
                'id' => $entry->getObjectId(),
                'several' => $entry->hasSeveralObjects(),
            ],
        ];
    }

    private function title(AppActivity $entry): string
    {
        if (AppActivity::NOT_RECORDED === $entry->getAction()) {
            return 'More activity was not recorded';
        }
        $method = $entry->getMethod();
        if (null === $method) {
            return ($this->tools->all()[$entry->getAction()] ?? null)->title ?? $entry->getAction();
        }

        if (ActivityKind::Send === $entry->getKind()) {
            return \in_array(Scope::ChatSend->value, $entry->getScopes(), true) ? 'Send a WhatsApp message' : 'Send mail';
        }
        $type = $entry->getObjectType() ?? 'Item';
        $one = self::withArticle(self::inSentence(self::objectLabel($type, false)));
        // Something under one of them (`/mail-accounts/{accountId}/folders`): named by its own last segment.
        $nested = 1 === preg_match('#\}/([a-z_-]+)$#', $entry->getAction(), $tail) ? ApiOperation::resourceOf($tail[1]) : null;
        if (\in_array($method, ['GET', 'HEAD'], true)) {
            return match (true) {
                $entry->isObjectList() => 'List '.self::inSentence(self::objectLabel($type, true)),
                null !== $nested => 'List '.self::inSentence(self::objectLabel($nested, true)).' of '.$one,
                default => 'Get '.$one,
            };
        }

        return match ($method) {
            'DELETE' => 'Delete '.$one,
            // A POST under one of them (`/notifications/{id}/snooze`) acts on it; any other POST adds one.
            'POST' => (null !== $nested ? 'Change ' : 'Add ').$one,
            default => 'Change '.$one,
        };
    }

    /**
     * @param array{name: string|null, type: string, held: list<string>} $app
     */
    private function sentence(AppActivity $entry, ActivityReason $reason, array $app): string
    {
        $name = $app['name'] ?? ('token' === $app['type'] ? 'This token' : 'This app');
        $nothing = ' Nothing was '.$entry->getKind()->nothingWas().'.';

        return match ($reason) {
            ActivityReason::NoPermission => $this->noPermission($entry, $name).$nothing,
            ActivityReason::TokenExpired => \sprintf('The token %s had expired.', $name).$nothing,
            ActivityReason::AccessRevoked => ('token' === $app['type'] ? \sprintf('The token %s was revoked.', $name) : \sprintf('%s was disconnected from your Tresso.', $name)).$nothing,
            ActivityReason::NotFound => \sprintf('%s asked for something that does not exist or is not yours.', $name).$nothing,
            ActivityReason::NotAccepted => \sprintf('Tresso did not accept the request as %s sent it.', $name).$nothing,
            ActivityReason::TooManyRequests => \sprintf('%s made too many requests in a short time.', $name).$nothing,
            ActivityReason::PaymentRequired => 'Your Tresso subscription is not active.'.$nothing,
            ActivityReason::Unavailable => 'Something Tresso needs did not answer in time.',
            ActivityReason::ServerError => 'Tresso could not finish this request.',
        };
    }

    /**
     * The refusal in words, from the scopes the app lacked when it was refused (kept with the entry), never from what
     * it holds now.
     */
    private function noPermission(AppActivity $entry, string $name): string
    {
        $missing = $entry->getMissingScopes();
        if ([] === $missing) {
            return 'Only Tresso\'s own apps may do this.';
        }
        $labels = array_map(self::scopeLabel(...), $missing);

        return \sprintf('%s did not have the permission%s %s.', $name, \count($labels) > 1 ? 's' : '', implode(' and ', $labels));
    }

    /** A scope's label; a scope this version no longer has is named neutrally. */
    private static function scopeLabel(string $value): string
    {
        return Scope::tryFrom($value)?->label() ?? 'A permission that no longer exists';
    }

    /**
     * The apps with their names, what they hold now and their ids in the settings, by key.
     *
     * @param list<ActivityApp> $apps
     *
     * @return array<string, array{key: string, type: string, name: string|null, connectedAppId: string|null, personalAccessTokenId: string|null, held: list<string>}>
     */
    private function apps(User $reader, array $apps): array
    {
        $clients = $tokens = [];
        foreach ($apps as $app) {
            if (ActivityApp::TOKEN === $app->type) {
                $tokens[$app->id] = true;
            } else {
                $clients[$app->id] = true;
            }
        }
        $owner = $reader->getId()->toRfc4122();

        $names = [];
        $consents = [];
        if ([] !== $clients) {
            foreach ($this->connection->fetchAllAssociative(
                'SELECT TRIM(c.identifier) AS identifier, c.name, s.id AS consent_id, s.scopes, s.disabled_scopes
                   FROM oauth2_client c
                   LEFT JOIN oauth_consent s ON s.client_id = c.identifier AND s.user_id = :owner
                  WHERE c.identifier IN (:ids)',
                ['owner' => $owner, 'ids' => array_keys($clients)],
                ['ids' => ArrayParameterType::STRING],
            ) as $row) {
                $names[self::text($row['identifier'])] = self::text($row['name']);
                if (null !== $row['consent_id']) {
                    $consents[self::text($row['identifier'])] = [
                        'id' => self::text($row['consent_id']),
                        'held' => array_values(array_diff(self::list($row['scopes']), self::list($row['disabled_scopes']))),
                    ];
                }
            }
        }

        $personal = [];
        if ([] !== $tokens) {
            foreach ($this->connection->fetchAllAssociative(
                'SELECT id, name, scopes FROM personal_access_token WHERE owner_id = :owner AND id IN (:ids)',
                ['owner' => $owner, 'ids' => array_keys($tokens)],
                ['ids' => ArrayParameterType::STRING],
            ) as $row) {
                $personal[self::text($row['id'])] = ['name' => self::text($row['name']), 'held' => self::list($row['scopes'])];
            }
        }

        $described = [];
        foreach ($apps as $app) {
            $key = $app->key();
            if (ActivityApp::TOKEN === $app->type) {
                $token = $personal[$app->id] ?? null;
                $described[$key] = [
                    'key' => $key,
                    'type' => 'token',
                    'name' => $token['name'] ?? null,
                    'connectedAppId' => null,
                    'personalAccessTokenId' => null === $token ? null : $app->id,
                    'held' => $token['held'] ?? [],
                ];
            } else {
                $consent = $consents[$app->id] ?? null;
                $described[$key] = [
                    'key' => $key,
                    'type' => 'client',
                    'name' => $names[$app->id] ?? null,
                    'connectedAppId' => $consent['id'] ?? null,
                    'personalAccessTokenId' => null,
                    'held' => $consent['held'] ?? [],
                ];
            }
        }

        return $described;
    }

    /** @return list<string> */
    private static function list(mixed $json): array
    {
        $value = \is_string($json) ? json_decode($json, true) : null;

        return \is_array($value) ? array_values(array_filter($value, \is_string(...))) : [];
    }

    public static function objectLabel(string $type, bool $list): string
    {
        if (isset(self::OBJECTS[$type])) {
            return self::OBJECTS[$type][$list ? 1 : 0];
        }
        $words = ucfirst(strtolower((string) preg_replace('/(?<=[a-z])(?=[A-Z])/', ' ', $type)));
        if (!$list || str_ends_with($words, 's')) {
            return $words;
        }

        return match (true) {
            str_ends_with($words, 'x') => $words.'es',
            1 === preg_match('/[^aeiou]y$/', $words) => substr($words, 0, -1).'ies',
            default => $words.'s',
        };
    }

    private static function withArticle(string $label): string
    {
        if (str_ends_with($label, 's') || str_starts_with($label, 'your ') || 'server information' === $label) {
            return $label;
        }

        return (1 === preg_match('/^[aeiou]/i', $label) ? 'an ' : 'a ').$label;
    }

    /** The label inside a sentence: lower case first, except a name such as WhatsApp. */
    private static function inSentence(string $label): string
    {
        return str_starts_with($label, 'WhatsApp') ? $label : (string) preg_replace_callback('/^[A-Z]/', static fn (array $m): string => strtolower($m[0]), $label);
    }

    /** A text column as a string. */
    private static function text(mixed $value): string
    {
        return \is_scalar($value) ? (string) $value : '';
    }
}
