<?php

declare(strict_types=1);

namespace App\State;

use ApiPlatform\Metadata\Operation;
use ApiPlatform\State\ProviderInterface;
use App\ApiResource\SyncChanges;
use App\Calendar\LocalCalendars;
use App\Chat\ChatViews;
use App\Classification\BuiltinSmartInboxes;
use App\Classification\ReceivingServers;
use App\Entity\Calendar;
use App\Enum\ChatOutgoingStatus;
use App\Enum\MailProvider;
use App\Mail\MessageFields;
use App\Security\ChatAccessVoter;
use App\Security\CurrentUser;
use App\Security\FirstPartyClients;
use App\Security\Scope;
use App\Unsubscribe\UnsubscribeLink;
use Doctrine\DBAL\ArrayParameterType;
use Doctrine\DBAL\Connection;
use Symfony\Bundle\SecurityBundle\Security;
use Symfony\Component\HttpFoundation\RequestStack;
use Symfony\Component\Uid\Uuid;

/**
 * Reads the user's changes after a change number, in pages that never split one change number.
 *
 * Each list needs the scope its own endpoints need ({@see self::SCOPES}); a token without it gets that list empty and
 * no `deleted` entries of its types. The cursor and the paging count every change, whatever the token holds, so the
 * cursor means the same for every token of a user. Chats ({@see self::CHAT_TYPES}) are read only as
 * {@see ChatAccessVoter::READ} allows: our own apps, or a caller holding `chat:read`.
 *
 * @implements ProviderInterface<SyncChanges>
 */
final readonly class SyncChangesProvider implements ProviderInterface
{
    private const int DEFAULT_LIMIT = 500;

    /** The scope each kind of entity needs, by its change type (also the `type` of its `deleted` entries). */
    public const array SCOPES = [
        'mailAccount' => Scope::MailRead,
        'folder' => Scope::MailRead,
        'thread' => Scope::MailRead,
        'message' => Scope::MailRead,
        'outgoingMessage' => Scope::MailRead,
        'draft' => Scope::MailRead,
        'unsubscription' => Scope::MailRead,
        'mailNotification' => Scope::MailRead,
        'handOver' => Scope::MailRead,
        'dailyBrief' => Scope::MailRead,
        'calendar' => Scope::CalendarRead,
        'calendarEvent' => Scope::CalendarRead,
        'notification' => Scope::CalendarRead,
        'eventNote' => Scope::CalendarRead,
        'todo' => Scope::TodosRead,
        'signature' => Scope::SignaturesRead,
        'smartInbox' => Scope::SettingsRead,
    ];

    /** Change types of chats, which no scope above grants: {@see ChatAccessVoter::READ} decides, for them and their removals. */
    public const array CHAT_TYPES = ['chatAccount', 'chat', 'chatMessage', 'chatOutgoing'];

    public function __construct(
        private Connection $connection,
        private CurrentUser $currentUser,
        private RequestStack $requests,
        private BuiltinSmartInboxes $builtinSmartInboxes,
        private LocalCalendars $localCalendars,
        private MessageFields $fields,
        private ChatViews $chatViews,
        private Security $security,
    ) {
    }

    public function provide(Operation $operation, array $uriVariables = [], array $context = []): SyncChanges
    {
        $user = $this->currentUser->get();
        // Only our own apps keep a copy that needs these; a script or another app reading the delta changes nothing.
        $ourApp = FirstPartyClients::signedRequest($this->security->getToken());
        if ($ourApp) {
            // A user from before calendars gets the Tresso calendar on the first pull, so every client has one to use.
            $this->localCalendars->ensure($user);
        }
        $userId = $user->getId()->toRfc4122();
        $query = $this->requests->getCurrentRequest()?->query;
        $since = (int) ($query?->get('since') ?? 0);
        $limit = (int) ($query?->get('limit') ?? self::DEFAULT_LIMIT);

        // A sync from the start (a new device, or a copy rebuilt) also brings smart inboxes made before they synced.
        if (0 === $since && $ourApp) {
            $this->connection->transactional(fn () => $this->builtinSmartInboxes->syncOlder($user));
        }

        [$until, $hasMore] = $this->boundary($userId, $since, $limit);
        $latest = $this->latest($userId, $until);
        // Named arguments: a list added to SyncChanges but not here (or the other way round) fails loudly.
        if ($until === $since) {
            return new SyncChanges(
                cursor: $since,
                hasMore: false,
                latest: $latest,
                mailAccounts: [],
                folders: [],
                threads: [],
                messages: [],
                outgoingMessages: [],
                signatures: [],
                drafts: [],
                smartInboxes: [],
                calendars: [],
                calendarEvents: [],
                notifications: [],
                eventNotes: [],
                todos: [],
                mailNotifications: [],
                unsubscriptions: [],
                handOvers: [],
                dailyBriefs: [],
                chatAccounts: [],
                chats: [],
                chatMessages: [],
                chatOutgoing: [],
                deleted: [],
            );
        }

        $range = ['user' => $userId, 'since' => $since, 'until' => $until];
        $granted = $this->grantedTypes();

        return new SyncChanges(
            cursor: $until,
            hasMore: $hasMore,
            latest: $latest,
            mailAccounts: $this->readIf($granted, 'mailAccount', $this->mailAccounts(...), $range),
            folders: $this->readIf($granted, 'folder', $this->folders(...), $range),
            threads: $this->readIf($granted, 'thread', $this->threads(...), $range),
            messages: $this->readIf($granted, 'message', $this->messages(...), $range),
            outgoingMessages: $this->readIf($granted, 'outgoingMessage', $this->outgoingMessages(...), $range),
            signatures: $this->readIf($granted, 'signature', $this->signatures(...), $range),
            drafts: $this->readIf($granted, 'draft', $this->drafts(...), $range),
            smartInboxes: $this->readIf($granted, 'smartInbox', $this->smartInboxes(...), $range),
            calendars: $this->readIf($granted, 'calendar', $this->calendars(...), $range),
            calendarEvents: $this->readIf($granted, 'calendarEvent', $this->calendarEvents(...), $range),
            notifications: $this->readIf($granted, 'notification', $this->notifications(...), $range),
            eventNotes: $this->readIf($granted, 'eventNote', $this->eventNotes(...), $range),
            todos: $this->readIf($granted, 'todo', $this->todos(...), $range),
            mailNotifications: $this->readIf($granted, 'mailNotification', $this->mailNotifications(...), $range),
            unsubscriptions: $this->readIf($granted, 'unsubscription', $this->unsubscriptions(...), $range),
            handOvers: $this->readIf($granted, 'handOver', $this->handOvers(...), $range),
            dailyBriefs: $this->readIf($granted, 'dailyBrief', $this->dailyBriefs(...), $range),
            chatAccounts: $this->readIf($granted, 'chatAccount', $this->chatAccounts(...), $range),
            chats: $this->readIf($granted, 'chat', $this->chats(...), $range),
            chatMessages: $this->readIf($granted, 'chatMessage', $this->chatMessages(...), $range),
            chatOutgoing: $this->readIf($granted, 'chatOutgoing', $this->chatOutgoing(...), $range),
            deleted: [] === $granted ? [] : $this->deleted($range, $granted),
        );
    }

    /**
     * @param list<string>                                                                       $granted
     * @param \Closure(array{user: string, since: int, until: int}): list<array<string, mixed>> $reader
     * @param array{user: string, since: int, until: int}                                        $range
     *
     * @return list<array<string, mixed>>
     */
    private function readIf(array $granted, string $type, \Closure $reader, array $range): array
    {
        return \in_array($type, $granted, true) ? $reader($range) : [];
    }

    /**
     * The change types the request's token may read.
     *
     * @return list<string>
     */
    private function grantedTypes(): array
    {
        $granted = [];
        foreach (self::SCOPES as $type => $scope) {
            if ($this->security->isGranted($scope->role())) {
                $granted[] = $type;
            }
        }
        if ($this->security->isGranted(ChatAccessVoter::READ)) {
            array_push($granted, ...self::CHAT_TYPES);
        }

        return $granted;
    }

    /**
     * The newest change number handed out to the user, so a client can tell how far behind it is: one primary-key read
     * of the user's row, which the {@see \App\Sync\Change\ChangeSequencer} keeps current. Read after the page's
     * boundary, so it is never below the page's cursor: the rows the boundary saw were committed with their numbers,
     * and the row's number commits with them. It may be above the last row a client will ever get (a number whose rows
     * changed again later, or that only rows another token cannot read carry), so clients take `hasMore: false`, not
     * reaching this number, as the end of a pull.
     */
    private function latest(string $userId, int $until): int
    {
        $latest = $this->connection->fetchOne('SELECT change_seq FROM app_user WHERE id = :user', ['user' => $userId]);

        return max($until, is_numeric($latest) ? (int) $latest : 0);
    }

    /**
     * The highest change number such that the page holds at most $limit entities, but always at least one complete
     * change number.
     *
     * Every part reads at most $limit + 1 change numbers through its (owner or account or calendar, change_seq) index,
     * so a page costs the same however much is left after it. That gives the same answer as aggregating everything: a
     * change number among the first $limit + 1 of all of them is among the first $limit + 1 of every part it is in.
     *
     * @return array{int, bool} [until, hasMore]
     */
    private function boundary(string $userId, int $since, int $limit): array
    {
        $byOwner = static fn (string $table, string $owner, string $extra = ''): string => \sprintf(
            '(SELECT x.change_seq, COUNT(*) AS rows FROM %1$s x WHERE x.%2$s = :user AND x.change_seq > :since%3$s GROUP BY x.change_seq ORDER BY x.change_seq LIMIT :groups)',
            $table, $owner, $extra,
        );
        // Per account (or calendar) of the user, so each scan follows that index in change number order.
        $byParent = static fn (string $table, string $column, string $parent = 'mail_account'): string => \sprintf(
            '(SELECT x.change_seq, x.rows FROM %3$s p CROSS JOIN LATERAL (
                SELECT y.change_seq, COUNT(*) AS rows FROM %1$s y WHERE y.%2$s = p.id AND y.change_seq > :since GROUP BY y.change_seq ORDER BY y.change_seq LIMIT :groups
             ) x WHERE p.owner_id = :user)',
            $table, $column, $parent,
        );
        $parts = [
            $byOwner('mail_account', 'owner_id'),
            $byParent('folder', 'mail_account_id'),
            $byParent('thread', 'mail_account_id'),
            $byParent('message', 'mail_account_id'),
            $byParent('outgoing_message', 'mail_account_id'),
            $byOwner('signature', 'owner_id'),
            $byOwner('draft', 'owner_id', ' AND x.sending_as_id IS NULL'),
            $byOwner('category', 'owner_id'),
            $byOwner('calendar', 'owner_id'),
            $byParent('calendar_event', 'calendar_id', 'calendar'),
            $byOwner('scheduled_notification', 'user_id'),
            $byOwner('event_note', 'user_id'),
            $byOwner('todo', 'owner_id'),
            $byOwner('mail_notification', 'user_id'),
            $byParent('unsubscription', 'mail_account_id'),
            $byOwner('hand_over', 'owner_id'),
            $byOwner('daily_brief', 'owner_id'),
            $byOwner('chat_account', 'owner_id'),
            $byParent('chat', 'chat_account_id', 'chat_account'),
            $byParent('chat_message', 'chat_account_id', 'chat_account'),
            $byParent('chat_outgoing', 'chat_account_id', 'chat_account'),
            $byOwner('sync_tombstone', 'user_id'),
        ];

        /** @var list<array{change_seq: int|string, rows: int|string}> $groups */
        $groups = $this->connection->fetchAllAssociative(
            'SELECT change_seq, SUM(rows) AS rows FROM ('.implode("\n UNION ALL\n", $parts).') changes
            GROUP BY change_seq
            ORDER BY change_seq
            LIMIT :groups',
            ['user' => $userId, 'since' => $since, 'groups' => $limit + 1],
        );

        // Every change number has at least one row, so $limit + 1 groups always reach past a full page.
        $until = $since;
        $total = 0;
        foreach ($groups as $group) {
            $rows = self::int($group['rows']);
            if ($total > 0 && $total + $rows > $limit) {
                return [$until, true];
            }
            $total += $rows;
            $until = self::int($group['change_seq']);
        }

        return [$until, false];
    }

    /**
     * @param array{user: string, since: int, until: int} $range
     *
     * @return list<array<string, mixed>>
     */
    private function mailAccounts(array $range): array
    {
        $rows = $this->connection->fetchAllAssociative(
            'SELECT a.id, a.email_address, a.display_name, a.provider, a.status, a.status_detail, a.last_synced_at, a.default_signature_id,
                    a.calendar_status, a.calendar_status_detail, a.calendar_found_url
             FROM mail_account a WHERE a.owner_id = :user AND a.change_seq > :since AND a.change_seq <= :until ORDER BY a.change_seq, a.id',
            $range,
        );

        return array_map(static fn (array $r): array => [
            'id' => $r['id'],
            'emailAddress' => $r['email_address'],
            'displayName' => $r['display_name'],
            'provider' => $r['provider'],
            'status' => $r['status'],
            'statusDetail' => $r['status_detail'],
            'lastSyncedAt' => self::date($r['last_synced_at']),
            'defaultSignatureId' => $r['default_signature_id'],
            'calendarStatus' => $r['calendar_status'],
            'calendarStatusDetail' => $r['calendar_status_detail'],
            'calendarFoundUrl' => $r['calendar_found_url'],
        ], $rows);
    }

    /**
     * @param array{user: string, since: int, until: int} $range
     *
     * @return list<array<string, mixed>>
     */
    private function folders(array $range): array
    {
        $rows = $this->connection->fetchAllAssociative(
            'SELECT f.id, f.mail_account_id, f.remote_name, f.display_name, f.role
             FROM folder f JOIN mail_account a ON a.id = f.mail_account_id
             WHERE a.owner_id = :user AND f.change_seq > :since AND f.change_seq <= :until ORDER BY f.change_seq, f.id',
            $range,
        );

        return array_map(static fn (array $r): array => [
            'id' => $r['id'],
            'mailAccountId' => $r['mail_account_id'],
            'name' => $r['remote_name'],
            'displayName' => $r['display_name'],
            'role' => $r['role'],
        ], $rows);
    }

    /**
     * @param array{user: string, since: int, until: int} $range
     *
     * @return list<array<string, mixed>>
     */
    private function threads(array $range): array
    {
        $rows = $this->connection->fetchAllAssociative(
            'SELECT t.id, t.mail_account_id, t.subject, t.message_count, t.last_message_at, t.category_id, t.verdict, t.classification_reason,
                    t.held_until, t.batched_at
             FROM thread t JOIN mail_account a ON a.id = t.mail_account_id
             WHERE a.owner_id = :user AND t.change_seq > :since AND t.change_seq <= :until ORDER BY t.change_seq, t.id',
            $range,
        );

        return array_map(static fn (array $r): array => [
            'id' => $r['id'],
            'mailAccountId' => $r['mail_account_id'],
            'subject' => $r['subject'],
            'messageCount' => self::int($r['message_count']),
            'lastMessageAt' => self::date($r['last_message_at']),
            'smartInboxId' => $r['category_id'],
            'verdict' => $r['verdict'],
            'classificationReason' => $r['classification_reason'],
            'heldUntil' => self::date($r['held_until']),
            'batchedAt' => self::date($r['batched_at']),
        ], $rows);
    }

    /**
     * @param array{user: string, since: int, until: int} $range
     *
     * @return list<array<string, mixed>>
     */
    private function messages(array $range): array
    {
        $rows = $this->connection->fetchAllAssociative(
            "SELECT m.id, m.mail_account_id, m.thread_id, m.subject, m.from_address, m.from_name, m.recipients, m.snippet, m.sealed_snippet,
                    m.sent_at, m.received_at, m.seen, m.flagged, m.answered, m.draft, m.has_attachments, m.attachment_scan,
                    m.category_id, m.verdict, m.summary, m.held_until, m.batched_at,
                    (SELECT i.method FROM calendar_invitation i WHERE i.message_id = m.id ORDER BY i.id LIMIT 1) AS calendar_method,
                    EXISTS (SELECT 1 FROM calendar_invitation i WHERE i.message_id = m.id AND i.waits_for_user AND i.applied_at IS NULL) AS calendar_waiting,
                    a.provider, s.headers AS signal_headers,
                    COALESCE((SELECT json_agg(l.folder_id ORDER BY l.folder_id) FROM message_location l WHERE l.message_id = m.id), '[]') AS folder_ids
             FROM message m JOIN mail_account a ON a.id = m.mail_account_id
             LEFT JOIN message_signals s ON s.message_id = m.id
             WHERE a.owner_id = :user AND m.change_seq > :since AND m.change_seq <= :until ORDER BY m.change_seq, m.id",
            $range,
        );

        $owner = Uuid::fromString($range['user']);

        return array_map(function (array $r) use ($owner): array {
            $unsubscribe = self::unsubscribeLink($r);

            return [
                'id' => $r['id'],
                'mailAccountId' => $r['mail_account_id'],
                'threadId' => $r['thread_id'],
                'folderIds' => json_decode(\is_string($r['folder_ids']) ? $r['folder_ids'] : '[]', true, flags: \JSON_THROW_ON_ERROR),
                'subject' => $r['subject'],
                'from' => ['address' => $r['from_address'], 'name' => $r['from_name']],
                'recipients' => json_decode(\is_string($r['recipients']) ? $r['recipients'] : '{}', true, flags: \JSON_THROW_ON_ERROR),
                'snippet' => $this->fields->snippetOf($owner, Uuid::fromString(self::text($r['id'])), self::nullableText($r['sealed_snippet']), self::text($r['snippet'])),
                'sentAt' => self::date($r['sent_at']),
                'receivedAt' => self::date($r['received_at']),
                'flags' => ['seen' => (bool) $r['seen'], 'flagged' => (bool) $r['flagged'], 'answered' => (bool) $r['answered'], 'draft' => (bool) $r['draft']],
                'hasAttachments' => (bool) $r['has_attachments'],
                'attachmentScan' => $r['attachment_scan'],
                'smartInboxId' => $r['category_id'],
                'verdict' => $r['verdict'],
                'summary' => $r['summary'],
                'calendarMethod' => $r['calendar_method'],
                // Calendar mail the provider did not confirm the sender of: it waits for the user to apply it.
                'calendarWaiting' => (bool) $r['calendar_waiting'],
                'heldUntil' => self::date($r['held_until']),
                'batchedAt' => self::date($r['batched_at']),
                'unsubscribe' => $unsubscribe?->method->value,
                'unsubscribeMailto' => $unsubscribe?->recipient,
            ];
        }, $rows);
    }

    /**
     * How the message can be unsubscribed from; offered only when the sender is authenticated (see
     * {@see UnsubscribeLink}).
     *
     * @param array<string, mixed> $row with `signal_headers`, `from_address` and the account's `provider`
     */
    private static function unsubscribeLink(array $row): ?UnsubscribeLink
    {
        if (!\is_string($row['signal_headers'])) {
            return null;
        }
        /** @var array<string, string> $headers */
        $headers = json_decode($row['signal_headers'], true, flags: \JSON_THROW_ON_ERROR);

        return UnsubscribeLink::fromMessage($headers, self::text($row['from_address']), ReceivingServers::wroteResults(MailProvider::from(self::text($row['provider'])), $headers['authentication-results'] ?? null));
    }

    /**
     * Bcc recipients are included: only the sender's own clients see this.
     *
     * @param array{user: string, since: int, until: int} $range
     *
     * @return list<array<string, mixed>>
     */
    private function outgoingMessages(array $range): array
    {
        $rows = $this->connection->fetchAllAssociative(
            'SELECT o.id, o.mail_account_id, o.status, o.subject, o.recipients, o.send_at, o.sent_at, o.last_error, o.in_reply_to_id
             FROM outgoing_message o JOIN mail_account a ON a.id = o.mail_account_id
             WHERE a.owner_id = :user AND o.change_seq > :since AND o.change_seq <= :until ORDER BY o.change_seq, o.id',
            $range,
        );

        return array_map(static fn (array $r): array => [
            'id' => $r['id'],
            'mailAccountId' => $r['mail_account_id'],
            'status' => $r['status'],
            'subject' => $r['subject'],
            'recipients' => json_decode(\is_string($r['recipients']) ? $r['recipients'] : '{}', true, flags: \JSON_THROW_ON_ERROR),
            'sendAt' => self::date($r['send_at']),
            'sentAt' => self::date($r['sent_at']),
            'lastError' => $r['last_error'],
            'inReplyToMessageId' => $r['in_reply_to_id'],
        ], $rows);
    }

    /**
     * @param array{user: string, since: int, until: int} $range
     *
     * @return list<array<string, mixed>>
     */
    private function signatures(array $range): array
    {
        $rows = $this->connection->fetchAllAssociative(
            'SELECT g.id, g.name, g.html, g.updated_at
             FROM signature g WHERE g.owner_id = :user AND g.change_seq > :since AND g.change_seq <= :until ORDER BY g.change_seq, g.id',
            $range,
        );

        return array_map(static fn (array $r): array => [
            'id' => $r['id'],
            'name' => $r['name'],
            'html' => $r['html'],
            'updatedAt' => self::date($r['updated_at']),
        ], $rows);
    }

    /**
     * @param array{user: string, since: int, until: int} $range
     *
     * @return list<array<string, mixed>>
     */
    private function drafts(array $range): array
    {
        $rows = $this->connection->fetchAllAssociative(
            'SELECT d.id, d.mail_account_id, d.kind, d.recipients, d.subject, d.html, d.signature_id, d.quote_html, d.in_reply_to_id, d.version, d.updated_at
             FROM draft d WHERE d.owner_id = :user AND d.change_seq > :since AND d.change_seq <= :until AND d.sending_as_id IS NULL ORDER BY d.change_seq, d.id',
            $range,
        );
        // The files without links: links expire, and the copy on a device lasts. GET /drafts/{id} has fresh ones.
        $attachments = [];
        if ([] !== $rows) {
            foreach ($this->connection->fetchAllAssociative(
                'SELECT a.draft_id, a.id, a.filename, a.content_type, a.size, a.scan_status, a.inline, a.content_id FROM draft_attachment a
                 WHERE a.draft_id = ANY(CAST(:drafts AS UUID[])) ORDER BY a.draft_id, a.position',
                ['drafts' => '{'.implode(',', array_map(static fn (array $r): string => self::text($r['id']), $rows)).'}'],
            ) as $a) {
                $attachments[self::text($a['draft_id'])][] = [
                    'id' => $a['id'],
                    'filename' => $a['filename'],
                    'contentType' => $a['content_type'],
                    'size' => self::int($a['size']),
                    'scanStatus' => $a['scan_status'],
                    'inline' => (bool) $a['inline'],
                    'contentId' => $a['content_id'],
                ];
            }
        }

        return array_map(static function (array $r) use ($attachments): array {
            /** @var array{to?: list<array{address: string, name: ?string}>, cc?: list<array{address: string, name: ?string}>, bcc?: list<array{address: string, name: ?string}>} $recipients */
            $recipients = json_decode(\is_string($r['recipients']) ? $r['recipients'] : '{}', true, flags: \JSON_THROW_ON_ERROR);

            return [
                'id' => $r['id'],
                'mailAccountId' => $r['mail_account_id'],
                'kind' => $r['kind'],
                'to' => $recipients['to'] ?? [],
                'cc' => $recipients['cc'] ?? [],
                'bcc' => $recipients['bcc'] ?? [],
                'subject' => $r['subject'],
                'html' => $r['html'],
                'signatureId' => $r['signature_id'],
                'quoteHtml' => $r['quote_html'],
                'inReplyToMessageId' => $r['in_reply_to_id'],
                'version' => self::int($r['version']),
                'updatedAt' => self::date($r['updated_at']),
                'attachments' => $attachments[self::text($r['id'])] ?? [],
            ];
        }, $rows);
    }

    /**
     * @param array{user: string, since: int, until: int} $range
     *
     * @return list<array<string, mixed>>
     */
    private function smartInboxes(array $range): array
    {
        $rows = $this->connection->fetchAllAssociative(
            'SELECT c.id, c.builtin, c.name, c.instructions, c.include_senders, c.exclude_senders, c.verdict, c.auto_create_todo, c.batch_delivery, c.position
             FROM category c WHERE c.owner_id = :user AND c.change_seq > :since AND c.change_seq <= :until ORDER BY c.change_seq, c.position, c.id',
            $range,
        );

        return array_map(static fn (array $r): array => [
            'id' => $r['id'],
            'builtin' => $r['builtin'],
            'name' => $r['name'],
            'instructions' => $r['instructions'],
            'includeSenders' => json_decode(\is_string($r['include_senders']) ? $r['include_senders'] : '[]', true, flags: \JSON_THROW_ON_ERROR),
            'excludeSenders' => json_decode(\is_string($r['exclude_senders']) ? $r['exclude_senders'] : '[]', true, flags: \JSON_THROW_ON_ERROR),
            'verdict' => $r['verdict'],
            'autoCreateTodo' => (bool) $r['auto_create_todo'],
            'batchDelivery' => (bool) $r['batch_delivery'],
            'position' => self::int($r['position']),
        ], $rows);
    }

    /**
     * @param array{user: string, since: int, until: int} $range
     *
     * @return list<array<string, mixed>>
     */
    private function unsubscriptions(array $range): array
    {
        $rows = $this->connection->fetchAllAssociative(
            'SELECT u.id, u.mail_account_id, u.sender, u.method, u.status, u.error, u.requested_at, u.completed_at
             FROM unsubscription u JOIN mail_account a ON a.id = u.mail_account_id
             WHERE a.owner_id = :user AND u.change_seq > :since AND u.change_seq <= :until ORDER BY u.change_seq, u.id',
            $range,
        );

        return array_map(static fn (array $r): array => [
            'id' => $r['id'],
            'mailAccountId' => $r['mail_account_id'],
            'sender' => $r['sender'],
            'method' => $r['method'],
            'status' => $r['status'],
            'error' => $r['error'],
            'requestedAt' => self::date($r['requested_at']),
            'completedAt' => self::date($r['completed_at']),
        ], $rows);
    }

    /**
     * @param array{user: string, since: int, until: int} $range
     *
     * @return list<array<string, mixed>>
     */
    private function calendars(array $range): array
    {
        $rows = $this->connection->fetchAllAssociative(
            'SELECT c.id, c.mail_account_id, c.source, c.name, c.color, c.user_color, c.time_zone, c.writable, c.is_default,
                    c.visible, c.work, c.provider_schedules, c.conference_providers, c.position
             FROM calendar c WHERE c.owner_id = :user AND c.change_seq > :since AND c.change_seq <= :until ORDER BY c.change_seq, c.position, c.id',
            $range,
        );

        return array_map(static fn (array $r): array => [
            'id' => $r['id'],
            'mailAccountId' => $r['mail_account_id'],
            'source' => $r['source'],
            'name' => $r['name'],
            'color' => $r['user_color'] ?? $r['color'] ?? Calendar::DEFAULT_COLOR,
            'timeZone' => $r['time_zone'],
            'writable' => (bool) $r['writable'],
            'isDefault' => (bool) $r['is_default'],
            'visible' => (bool) $r['visible'],
            'work' => (bool) $r['work'],
            'providerSchedules' => (bool) $r['provider_schedules'],
            'conferenceProviders' => self::json($r['conference_providers'], '[]'),
            'position' => self::int($r['position']),
        ], $rows);
    }

    /**
     * Events as stored (single events, series and overrides), limited to those that matter now: their series ends
     * after the event window start. Older history is read through the occurrences endpoint.
     *
     * @param array{user: string, since: int, until: int} $range
     *
     * @return list<array<string, mixed>>
     */
    private function calendarEvents(array $range): array
    {
        $rows = $this->connection->fetchAllAssociative(
            'SELECT e.id, e.calendar_id, e.uid, e.recurrence_key, e.sequence, e.status, e.summary, e.description, e.location, e.url,
                    e.transparency, e.visibility, e.all_day, e.start_value, e.start_time_zone, e.end_value, e.end_time_zone,
                    e.rrule, e.rdates, e.exdates, e.organizer, e.attendees, e.self_partstat, e.reminders, e.conference,
                    e.message_id, e.sync_error, e.travel_minutes, e.default_reminders, e.important, e.this_and_future
             FROM calendar_event e JOIN calendar c ON c.id = e.calendar_id
             WHERE c.owner_id = :user AND e.change_seq > :since AND e.change_seq <= :until
               AND (e.series_ends_at IS NULL OR e.series_ends_at > :window)
             ORDER BY e.change_seq, e.id',
            [...$range, 'window' => self::eventWindow()],
        );

        return array_map(static fn (array $r): array => [
            'id' => $r['id'],
            'calendarId' => $r['calendar_id'],
            'uid' => $r['uid'],
            'recurrenceId' => '' === $r['recurrence_key'] ? null : $r['recurrence_key'],
            'sequence' => self::int($r['sequence']),
            'status' => $r['status'],
            'summary' => $r['summary'],
            'description' => $r['description'],
            'location' => $r['location'],
            'url' => $r['url'],
            'transparency' => $r['transparency'],
            'visibility' => $r['visibility'],
            'allDay' => (bool) $r['all_day'],
            'start' => (bool) $r['all_day'] ? ['date' => $r['start_value']] : ['dateTime' => $r['start_value'], 'timeZone' => $r['start_time_zone']],
            'end' => (bool) $r['all_day'] ? ['date' => $r['end_value']] : ['dateTime' => $r['end_value'], 'timeZone' => $r['end_time_zone']],
            'recurrence' => $r['rrule'],
            'rdates' => self::json($r['rdates'], '[]'),
            'exdates' => self::json($r['exdates'], '[]'),
            'organizer' => self::json($r['organizer'], 'null'),
            'attendees' => self::json($r['attendees'], '[]'),
            'selfResponse' => $r['self_partstat'],
            'reminders' => self::json($r['reminders'], '[]'),
            'conference' => self::json($r['conference'], 'null'),
            'messageId' => $r['message_id'],
            'syncError' => $r['sync_error'],
            'travelMinutes' => null === $r['travel_minutes'] ? null : self::int($r['travel_minutes']),
            'important' => (bool) $r['important'],
            'defaultReminders' => (bool) $r['default_reminders'],
            'thisAndFuture' => (bool) $r['this_and_future'],
        ], $rows);
    }

    /**
     * Delivered notifications of the last week; planned ones are no business of clients until they are delivered.
     *
     * @param array{user: string, since: int, until: int} $range
     *
     * @return list<array<string, mixed>>
     */
    private function notifications(array $range): array
    {
        $rows = $this->connection->fetchAllAssociative(
            // Delivered ones, and snoozed ones (a later round not delivered yet), so every device hides a snoozed
            // notification until it comes again.
            'SELECT n.id, n.kind, n.event_id, n.occurrence_key, n.title, n.body, n.occurrence_starts_at, n.delivered_at, n.dismissed_at, n.silent, n.round, n.snoozed, n.fire_at
             FROM scheduled_notification n
             WHERE n.user_id = :user AND n.change_seq > :since AND n.change_seq <= :until
               AND (n.delivered_at > :recent OR (n.delivered_at IS NULL AND n.round > 0 AND n.fire_at > :recent))
             ORDER BY n.change_seq, n.id',
            [...$range, 'recent' => new \DateTimeImmutable('-7 days')->format('Y-m-d H:i:s')],
        );

        return array_map(static fn (array $r): array => [
            'id' => $r['id'],
            'kind' => $r['kind'],
            'eventId' => $r['event_id'],
            'recurrenceId' => '' === $r['occurrence_key'] ? null : $r['occurrence_key'],
            'title' => $r['title'],
            'body' => $r['body'],
            'occurrenceStartsAt' => self::date($r['occurrence_starts_at']),
            'deliveredAt' => self::date($r['delivered_at']),
            'dismissedAt' => self::date($r['dismissed_at']),
            'silent' => (bool) $r['silent'],
            'round' => self::int($r['round']),
            // Not delivered in this round: snoozed until a time, or waiting for the occurrence's new time.
            'snoozedUntil' => null === $r['delivered_at'] && (bool) $r['snoozed'] ? self::date($r['fire_at']) : null,
        ], $rows);
    }

    /**
     * Delivered mail notifications of the last week; waiting and dropped ones never reach clients.
     *
     * @param array{user: string, since: int, until: int} $range
     *
     * @return list<array<string, mixed>>
     */
    private function mailNotifications(array $range): array
    {
        $rows = $this->connection->fetchAllAssociative(
            'SELECT n.id, n.message_id, n.thread_id, n.title, n.body, n.sealed_body, n.delivered_at, n.channels, n.silent, n.summary
             FROM mail_notification n
             WHERE n.user_id = :user AND n.change_seq > :since AND n.change_seq <= :until AND n.delivered_at > :recent
             ORDER BY n.change_seq, n.id',
            [...$range, 'recent' => new \DateTimeImmutable('-7 days')->format('Y-m-d H:i:s')],
        );

        $owner = Uuid::fromString($range['user']);

        return array_map(fn (array $r): array => [
            'id' => $r['id'],
            'messageId' => $r['message_id'],
            'threadId' => $r['thread_id'],
            'title' => $r['title'],
            'body' => $this->fields->notificationBodyOf($owner, Uuid::fromString(self::text($r['id'])), self::nullableText($r['sealed_body']), self::text($r['body'])),
            'deliveredAt' => self::date($r['delivered_at']),
            'channels' => self::json($r['channels'], '[]'),
            'silent' => (bool) $r['silent'],
            'summary' => (bool) $r['summary'],
        ], $rows);
    }

    /**
     * @param array{user: string, since: int, until: int} $range
     *
     * @return list<array<string, mixed>>
     */
    private function eventNotes(array $range): array
    {
        $rows = $this->connection->fetchAllAssociative(
            'SELECT o.id, o.event_id, o.occurrence_key, o.text, o.updated_at FROM event_note o
             WHERE o.user_id = :user AND o.change_seq > :since AND o.change_seq <= :until ORDER BY o.change_seq, o.id',
            $range,
        );

        return array_map(static fn (array $r): array => [
            'id' => $r['id'],
            'eventId' => $r['event_id'],
            'recurrenceId' => '' === $r['occurrence_key'] ? null : $r['occurrence_key'],
            'text' => $r['text'],
            'updatedAt' => self::date($r['updated_at']),
        ], $rows);
    }

    /**
     * @param array{user: string, since: int, until: int} $range
     *
     * @return list<array<string, mixed>>
     */
    private function todos(array $range): array
    {
        $rows = $this->connection->fetchAllAssociative(
            'SELECT o.id, o.title, o.notes, o.due_date, o.due_time, o.duration_minutes, o.completed_at, o.position, o.source,
                    o.message_id, m.thread_id, o.planned_start, o.planned_end, o.plan_state, o.created_at, o.updated_at
             FROM todo o LEFT JOIN message m ON m.id = o.message_id
             WHERE o.owner_id = :user AND o.change_seq > :since AND o.change_seq <= :until ORDER BY o.change_seq, o.position, o.id',
            $range,
        );

        return array_map(static fn (array $r): array => [
            'id' => $r['id'],
            'title' => $r['title'],
            'notes' => $r['notes'],
            'dueDate' => $r['due_date'],
            'dueTime' => null === $r['due_time'] ? null : substr(self::text($r['due_time']), 0, 5),
            'durationMinutes' => null === $r['duration_minutes'] ? null : self::int($r['duration_minutes']),
            'completedAt' => self::date($r['completed_at']),
            'position' => self::int($r['position']),
            'source' => $r['source'],
            'messageId' => $r['message_id'],
            'threadId' => $r['thread_id'],
            'plannedStart' => self::date($r['planned_start']),
            'plannedEnd' => self::date($r['planned_end']),
            'planState' => $r['plan_state'],
            'createdAt' => self::date($r['created_at']),
            'updatedAt' => self::date($r['updated_at']),
        ], $rows);
    }

    /** The delta carries events whose series ends after this. */
    private static function eventWindow(): string
    {
        return new \DateTimeImmutable('-2 years')->format('Y-m-d H:i:s');
    }

    private static function json(mixed $value, string $empty): mixed
    {
        return json_decode(\is_string($value) ? $value : $empty, true, flags: \JSON_THROW_ON_ERROR);
    }

    /**
     * @param array{user: string, since: int, until: int} $range
     *
     * @return list<array<string, mixed>>
     */
    private function handOvers(array $range): array
    {
        $rows = $this->connection->fetchAllAssociative(
            'SELECT h.id, h.mail_account_id, h.message_id, COALESCE(m.thread_id, h.thread_id) AS thread_id, h.subject, h.delegate_address, h.delegate_name, h.note,
                    h.due_at, h.state, h.forward_id, h.overdue_at, h.notified_at, h.notified_channels, h.notified_silently, h.nudged_at, h.last_nudge_id, h.reply_id, h.created_at,
                    h.closed_at, h.updated_at
             FROM hand_over h LEFT JOIN message m ON m.id = h.message_id
             WHERE h.owner_id = :user AND h.change_seq > :since AND h.change_seq <= :until ORDER BY h.change_seq, h.id',
            $range,
        );

        return array_map(static fn (array $r): array => [
            'id' => $r['id'],
            'mailAccountId' => $r['mail_account_id'],
            'messageId' => $r['message_id'],
            'threadId' => $r['thread_id'],
            'subject' => $r['subject'],
            'delegate' => ['address' => $r['delegate_address'], 'name' => $r['delegate_name']],
            'note' => $r['note'],
            'dueAt' => self::date($r['due_at']),
            'state' => $r['state'],
            'forwardId' => $r['forward_id'],
            'overdueAt' => self::date($r['overdue_at']),
            'notifiedAt' => self::date($r['notified_at']),
            'notifiedChannels' => json_decode(\is_string($r['notified_channels']) ? $r['notified_channels'] : '[]', true, flags: \JSON_THROW_ON_ERROR),
            'notifiedSilently' => (bool) $r['notified_silently'],
            'nudgedAt' => self::date($r['nudged_at']),
            'lastNudgeId' => $r['last_nudge_id'],
            'replyMessageId' => $r['reply_id'],
            'createdAt' => self::date($r['created_at']),
            'closedAt' => self::date($r['closed_at']),
            'updatedAt' => self::date($r['updated_at']),
        ], $rows);
    }

    /**
     * @param array{user: string, since: int, until: int} $range
     *
     * @return list<array<string, mixed>>
     */
    private function dailyBriefs(array $range): array
    {
        $rows = $this->connection->fetchAllAssociative(
            'SELECT b.id, b.covers_from, b.covers_until, b.thread_ids, b.created_at
             FROM daily_brief b WHERE b.owner_id = :user AND b.change_seq > :since AND b.change_seq <= :until ORDER BY b.change_seq, b.id',
            $range,
        );

        return array_map(static fn (array $r): array => [
            'id' => $r['id'],
            'coversFrom' => self::date($r['covers_from']),
            'coversUntil' => self::date($r['covers_until']),
            'threadIds' => json_decode(\is_string($r['thread_ids']) ? $r['thread_ids'] : '[]', true, flags: \JSON_THROW_ON_ERROR),
            'createdAt' => self::date($r['created_at']),
        ], $rows);
    }

    /**
     * @param array{user: string, since: int, until: int} $range
     *
     * @return list<array<string, mixed>>
     */
    private function chatAccounts(array $range): array
    {
        $rows = $this->connection->fetchAllAssociative(
            'SELECT '.ChatViews::ACCOUNT_COLUMNS.'
             FROM chat_account a WHERE a.owner_id = :user AND a.change_seq > :since AND a.change_seq <= :until ORDER BY a.change_seq, a.id',
            $range,
        );
        $owner = Uuid::fromString($range['user']);

        return array_map(fn (array $r): array => $this->chatViews->accountRow($owner, $r), $rows);
    }

    /**
     * @param array{user: string, since: int, until: int} $range
     *
     * @return list<array<string, mixed>>
     */
    private function chats(array $range): array
    {
        $rows = $this->connection->fetchAllAssociative(
            'SELECT '.ChatViews::CHAT_COLUMNS.'
             FROM chat c JOIN chat_account a ON a.id = c.chat_account_id
             WHERE a.owner_id = :user AND c.change_seq > :since AND c.change_seq <= :until ORDER BY c.change_seq, c.id',
            $range,
        );
        $owner = Uuid::fromString($range['user']);

        return array_map(fn (array $r): array => $this->chatViews->chatRow($owner, $r), $rows);
    }

    /**
     * The text is opened here: chats are short and must read offline.
     *
     * @param array{user: string, since: int, until: int} $range
     *
     * @return list<array<string, mixed>>
     */
    private function chatMessages(array $range): array
    {
        $rows = $this->connection->fetchAllAssociative(
            'SELECT '.ChatViews::MESSAGE_COLUMNS.'
             FROM chat_message m JOIN chat_account a ON a.id = m.chat_account_id
             WHERE a.owner_id = :user AND m.change_seq > :since AND m.change_seq <= :until ORDER BY m.change_seq, m.id',
            $range,
        );
        $owner = Uuid::fromString($range['user']);

        return array_map(fn (array $r): array => $this->chatViews->messageRow($owner, $r), $rows);
    }

    /**
     * Cancelled replies are not listed: clients drop them.
     *
     * @param array{user: string, since: int, until: int} $range
     *
     * @return list<array<string, mixed>>
     */
    private function chatOutgoing(array $range): array
    {
        $rows = $this->connection->fetchAllAssociative(
            'SELECT '.ChatViews::OUTGOING_COLUMNS.'
             FROM chat_outgoing o JOIN chat_account a ON a.id = o.chat_account_id
             WHERE a.owner_id = :user AND o.change_seq > :since AND o.change_seq <= :until AND o.status <> :cancelled ORDER BY o.change_seq, o.id',
            [...$range, 'cancelled' => ChatOutgoingStatus::Cancelled->value],
        );
        $owner = Uuid::fromString($range['user']);

        return array_map(fn (array $r): array => $this->chatViews->outgoingRow($owner, $r), $rows);
    }

    /**
     * @param array{user: string, since: int, until: int} $range
     * @param list<string>                                $types the change types the token may read
     *
     * @return list<array{type: string, id: string}>
     */
    private function deleted(array $range, array $types): array
    {
        // An event changed to end before the window leaves the clients' copies like a deleted one; a copy that
        // starts from nothing never had it.
        /** @var list<array{entity_type: string, entity_id: string}> $rows */
        $rows = $this->connection->fetchAllAssociative(
            'SELECT entity_type, entity_id FROM (
                SELECT s.entity_type, s.entity_id, s.change_seq FROM sync_tombstone s
                 WHERE s.user_id = :user AND s.change_seq > :since AND s.change_seq <= :until
                UNION ALL
                SELECT \'calendarEvent\', e.id, e.change_seq FROM calendar_event e JOIN calendar c ON c.id = e.calendar_id
                 WHERE :since > 0 AND c.owner_id = :user AND e.change_seq > :since AND e.change_seq <= :until AND e.series_ends_at <= :window
             ) gone WHERE entity_type IN (:types) ORDER BY change_seq, entity_type, entity_id',
            [...$range, 'window' => self::eventWindow(), 'types' => $types],
            ['types' => ArrayParameterType::STRING],
        );

        return array_map(static fn (array $r): array => ['type' => $r['entity_type'], 'id' => $r['entity_id']], $rows);
    }

    private static function text(mixed $value): string
    {
        return \is_string($value) ? $value : throw new \UnexpectedValueException('Expected a text column.');
    }

    private static function nullableText(mixed $value): ?string
    {
        return null === $value ? null : self::text($value);
    }

    private static function int(mixed $value): int
    {
        return is_numeric($value) ? (int) $value : throw new \UnexpectedValueException('Expected a number from the database.');
    }

    private static function date(mixed $value): ?string
    {
        return \is_string($value) ? new \DateTimeImmutable($value)->format(\DATE_ATOM) : null;
    }
}
