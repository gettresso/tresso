<?php

declare(strict_types=1);

namespace App\Chat;

use App\Entity\ChatAccount;
use App\Entity\User;
use App\Enum\ChatChannel;
use App\Enum\ChatOutgoingStatus;
use App\Repository\ChatAccountRepository;
use Doctrine\DBAL\Connection;
use Doctrine\DBAL\ParameterType;
use Psr\Clock\ClockInterface;
use Symfony\Component\HttpKernel\Exception\NotFoundHttpException;
use Symfony\Component\Uid\Uuid;

/**
 * Reads the signed-in user's WhatsApp on the server, page by page, for callers that do not keep a copy through the
 * delta (an MCP client, a script): the state of the chat account, the chats, one chat's messages and replies, and a
 * search. Every read goes through the owner: another user's chat is not found. Chats the user left out are neither
 * listed nor read. The rows are what {@see ChatViews} makes of them, as in the delta.
 *
 * Who may call is decided by the endpoints ({@see \App\Security\ChatAccessVoter}), not here.
 *
 * @phpstan-import-type ChatView from ChatViews
 * @phpstan-import-type MessageView from ChatViews
 *
 * @phpstan-type Status array{channel: string, onServer: bool, chatAccountId: ?string, relayDeviceName: ?string, relayOnline: ?bool, relayOfflineSince: ?string, bridge: ?string, link: ?string}
 * @phpstan-type ChatPage array{items: list<ChatView>, nextCursor: ?string}
 * @phpstan-type Timeline array{chat: ChatView, items: list<array<string, mixed>>, nextCursor: ?string}
 * @phpstan-type SearchHit array<string, mixed>
 * @phpstan-type SearchResult array{items: list<SearchHit>, query: string, from: string, scanned: int, scanLimit: int, searchedThrough: ?string, complete: bool, nextCursor: ?string}
 */
final readonly class ChatReader
{
    public const int MAX_LIMIT = 100;
    public const int DEFAULT_CHATS = 25;
    public const int DEFAULT_MESSAGES = 30;

    /** A search opens at most this many messages a call, newest first, so its cost stays bounded. */
    public const int SEARCH_SCAN = 2000;
    public const int SEARCH_DEFAULT_DAYS = 30;
    public const int SEARCH_MAX_DAYS = 90;
    public const int SEARCH_DEFAULT_LIMIT = 20;
    public const int SEARCH_MAX_LIMIT = 50;
    public const int QUERY_MIN = 2;
    public const int QUERY_MAX = 200;

    /** Messages a search reads from the database at once. */
    private const int SEARCH_BATCH = 250;

    /**
     * A sent reply is hidden when the bridge also stored it: an own message with the same text from 1 minute before to
     * 5 minutes after it went out, as `timeline()` in packages/core/src/chat/format.ts decides for the apps.
     */
    private const int ECHO_SKEW = 60;
    private const int ECHO_WINDOW = 300;

    /**
     * Sent replies are matched to stored copies oldest first; a reply can only lose its copy to one sent at most
     * ECHO_SKEW + ECHO_WINDOW before it. Looking this far back covers a run of the same reply sent five times in a row,
     * which is as far as the apps' rule needs to be followed here.
     */
    private const int ECHO_LOOKBACK = 1800;

    public function __construct(
        private Connection $connection,
        private ChatViews $views,
        private ChatFields $fields,
        private ChatAccountRepository $accounts,
        private ClockInterface $clock,
    ) {
    }

    /**
     * Whether the user's WhatsApp is on the server, and the relay's state. Names, numbers and messages are left out:
     * a caller that may only queue replies reads this too.
     *
     * @return Status
     */
    public function status(User $owner): array
    {
        $account = $this->accounts->findOneByChannel($owner, ChatChannel::WhatsApp);
        if (!$account instanceof ChatAccount) {
            return [
                'channel' => ChatChannel::WhatsApp->value,
                'onServer' => false,
                'chatAccountId' => null,
                'relayDeviceName' => null,
                'relayOnline' => null,
                'relayOfflineSince' => null,
                'bridge' => null,
                'link' => null,
            ];
        }
        $view = $this->views->account($account);

        return [
            'channel' => $view['channel'],
            'onServer' => true,
            'chatAccountId' => $view['id'],
            'relayDeviceName' => $view['relayDeviceName'],
            'relayOnline' => $view['relayOnline'],
            'relayOfflineSince' => $view['relayOfflineSince'],
            'bridge' => $view['bridge'],
            'link' => $view['link'],
        ];
    }

    /**
     * The user's chats with the newest message first, without those left out.
     *
     * @return ChatPage
     */
    public function chats(User $owner, int $limit, ?ChatCursor $cursor): array
    {
        $parameters = ['owner' => $owner->getId()->toRfc4122(), 'limit' => $limit + 1];
        $after = '';
        if (null !== $cursor) {
            $after = 'AND (c.last_message_at < :at OR (c.last_message_at = :at AND c.id < :id))';
            $parameters += ['at' => $cursor->at, 'id' => $cursor->id];
        }
        $rows = $this->connection->fetchAllAssociative(
            'SELECT '.ChatViews::CHAT_COLUMNS.'
             FROM chat c JOIN chat_account a ON a.id = c.chat_account_id
             WHERE a.owner_id = :owner AND c.left_out = false '.$after.'
             ORDER BY c.last_message_at DESC, c.id DESC LIMIT :limit',
            $parameters,
            ['limit' => ParameterType::INTEGER],
        );

        $more = \count($rows) > $limit;
        $rows = \array_slice($rows, 0, $limit);
        $last = [] === $rows ? null : $rows[array_key_last($rows)];

        return [
            'items' => array_map(fn (array $row): array => $this->views->chatRow($owner->getId(), $row), $rows),
            'nextCursor' => $more && null !== $last ? ChatCursor::of(self::text($last['last_message_at']), ChatCursor::MESSAGE, self::text($last['id']))->encode() : null,
        ];
    }

    /**
     * One chat with its messages and the user's replies (not those cancelled), newest first. A reply sorts by when it
     * went out, or else by when it was written; on the same second a reply comes before a message. A sent reply the
     * bridge also stored as an own message is left out, as the apps leave it out.
     *
     * @return Timeline
     *
     * @throws NotFoundHttpException for a chat that is not the user's, or that the user left out
     */
    public function timeline(User $owner, string $chatId, int $limit, ?ChatCursor $cursor): array
    {
        $chat = $this->ownChat($owner, $chatId);
        $chatUuid = $chat['id'];

        $messageParameters = ['chat' => $chatUuid, 'limit' => $limit + 1];
        $replyParameters = ['chat' => $chatUuid, 'limit' => $limit + 1, 'cancelled' => ChatOutgoingStatus::Cancelled->value];
        $messageAfter = '';
        $replyAfter = '';
        if (null !== $cursor) {
            // (time, rank, id) below the cursor's: a message has rank 0, a reply rank 1.
            $messageAfter = ChatCursor::REPLY === $cursor->rank
                ? 'AND m.sent_at <= :at'
                : 'AND (m.sent_at < :at OR (m.sent_at = :at AND m.id < :id))';
            $replyAfter = ChatCursor::REPLY === $cursor->rank
                ? 'AND (COALESCE(o.sent_at, o.created_at) < :at OR (COALESCE(o.sent_at, o.created_at) = :at AND o.id < :id))'
                : 'AND COALESCE(o.sent_at, o.created_at) < :at';
            $messageParameters += ['at' => $cursor->at] + (ChatCursor::REPLY === $cursor->rank ? [] : ['id' => $cursor->id]);
            $replyParameters += ['at' => $cursor->at] + (ChatCursor::REPLY === $cursor->rank ? ['id' => $cursor->id] : []);
        }

        $messages = $this->connection->fetchAllAssociative(
            'SELECT '.ChatViews::MESSAGE_COLUMNS.' FROM chat_message m
             WHERE m.chat_id = :chat '.$messageAfter.'
             ORDER BY m.sent_at DESC, m.id DESC LIMIT :limit',
            $messageParameters,
            ['limit' => ParameterType::INTEGER],
        );
        $replies = $this->connection->fetchAllAssociative(
            'SELECT '.ChatViews::OUTGOING_COLUMNS.', COALESCE(o.sent_at, o.created_at) AS sort_at FROM chat_outgoing o
             WHERE o.chat_id = :chat AND o.status <> :cancelled '.$replyAfter.'
             ORDER BY COALESCE(o.sent_at, o.created_at) DESC, o.id DESC LIMIT :limit',
            $replyParameters,
            ['limit' => ParameterType::INTEGER],
        );

        // Both lists are newest first; the newest $limit of the two together make the page.
        $merged = [];
        $m = 0;
        $r = 0;
        while (\count($merged) < $limit && ($m < \count($messages) || $r < \count($replies))) {
            $message = $messages[$m] ?? null;
            $reply = $replies[$r] ?? null;
            $messageKey = null === $message ? null : ChatCursor::of(self::text($message['sent_at']), ChatCursor::MESSAGE, self::text($message['id']));
            $replyKey = null === $reply ? null : ChatCursor::of(self::text($reply['sort_at']), ChatCursor::REPLY, self::text($reply['id']));
            if (null !== $replyKey && (null === $messageKey || $replyKey->after($messageKey))) {
                $merged[] = [$replyKey, 'reply', $reply];
                ++$r;
            } else {
                \assert(null !== $messageKey);
                $merged[] = [$messageKey, 'message', $message];
                ++$m;
            }
        }
        $more = $m < \count($messages) || $r < \count($replies);

        $owned = $owner->getId();
        $echoes = $this->storedReplies($owned, $chatUuid, array_values(array_map(
            static fn (array $entry): array => $entry[2],
            array_filter($merged, static fn (array $entry): bool => 'reply' === $entry[1]),
        )));
        $items = [];
        foreach ($merged as [, $type, $row]) {
            if ('message' === $type) {
                $items[] = ['type' => 'message'] + $this->views->messageRow($owned, $row);
            } elseif (!isset($echoes[self::text($row['id'])])) {
                $items[] = ['type' => 'reply'] + $this->views->outgoingRow($owned, $row);
            }
        }
        $last = [] === $merged ? null : $merged[array_key_last($merged)][0];

        return [
            'chat' => $this->views->chatRow($owned, $chat['row']),
            'items' => $items,
            'nextCursor' => $more && null !== $last ? $last->encode() : null,
        ];
    }

    /**
     * Messages whose text, file name or sender name holds $query (ignoring case), newest first, in the chats the user
     * did not leave out, from the last $days days. Chat text is sealed at rest, so there is no index to ask: each
     * message is opened to be compared. A call opens at most {@see SEARCH_SCAN} messages; when it stops there before the
     * window ends, `complete` is false and `nextCursor` goes on further back.
     *
     * @return SearchResult
     *
     * @throws NotFoundHttpException for a chat that is not the user's, or that the user left out
     */
    public function search(User $owner, string $query, int $days, ?string $chatId, int $limit, ?ChatCursor $cursor): array
    {
        $needle = mb_strtolower($query);
        $from = $this->clock->now()->modify(\sprintf('-%d days', $days));
        $parameters = ['owner' => $owner->getId()->toRfc4122(), 'from' => $from->format('Y-m-d H:i:s')];
        $inChat = '';
        if (null !== $chatId) {
            $parameters['chat'] = $this->ownChat($owner, $chatId)['id'];
            $inChat = 'AND m.chat_id = :chat';
        }

        $owned = $owner->getId();
        $chatNames = [];
        $hits = [];
        $scanned = 0;
        $last = $cursor;
        $complete = false;
        while (true) {
            $after = '';
            $batchParameters = $parameters + ['limit' => min(self::SEARCH_BATCH, self::SEARCH_SCAN - $scanned)];
            if (null !== $last) {
                $after = 'AND (m.sent_at < :at OR (m.sent_at = :at AND m.id < :id))';
                $batchParameters += ['at' => $last->at, 'id' => $last->id];
            }
            $rows = $this->connection->fetchAllAssociative(
                'SELECT '.ChatViews::MESSAGE_COLUMNS.', c.sealed_name AS chat_sealed_name, c.kind AS chat_kind
                 FROM chat_message m
                 JOIN chat c ON c.id = m.chat_id
                 JOIN chat_account a ON a.id = m.chat_account_id
                 WHERE a.owner_id = :owner AND c.left_out = false AND m.sent_at >= :from '.$inChat.' '.$after.'
                 ORDER BY m.sent_at DESC, m.id DESC LIMIT :limit',
                $batchParameters,
                ['limit' => ParameterType::INTEGER],
            );
            foreach ($rows as $row) {
                ++$scanned;
                $last = ChatCursor::of(self::text($row['sent_at']), ChatCursor::MESSAGE, self::text($row['id']));
                $message = $this->views->messageRow($owned, $row);
                if (!self::matches($needle, $message)) {
                    continue;
                }
                $chat = self::text($row['chat_id']);
                $chatNames[$chat] ??= $this->fields->open($owned, ChatField::Name, Uuid::fromString($chat), null === $row['chat_sealed_name'] ? null : self::text($row['chat_sealed_name']));
                $hits[] = ['chatName' => $chatNames[$chat], 'chatKind' => self::text($row['chat_kind'])] + $message;
                if (\count($hits) >= $limit) {
                    break 2;
                }
            }
            if (\count($rows) < $batchParameters['limit']) {
                $complete = true;
                break;
            }
            if ($scanned >= self::SEARCH_SCAN) {
                break;
            }
        }
        // A page that filled up on its last row may still be complete; the next call then finds nothing more.

        return [
            'items' => $hits,
            'query' => $query,
            'from' => $from->format(\DATE_ATOM),
            'scanned' => $scanned,
            'scanLimit' => self::SEARCH_SCAN,
            'searchedThrough' => null === $last || $last === $cursor ? null : new \DateTimeImmutable($last->at)->format(\DATE_ATOM),
            'complete' => $complete,
            'nextCursor' => $complete || null === $last ? null : $last->encode(),
        ];
    }

    /**
     * The chat as its row, when it is the owner's and not left out.
     *
     * @return array{id: string, row: array<string, mixed>}
     */
    private function ownChat(User $owner, string $chatId): array
    {
        if (!Uuid::isValid($chatId)) {
            throw new NotFoundHttpException('Chat not found.');
        }
        $row = $this->connection->fetchAssociative(
            'SELECT '.ChatViews::CHAT_COLUMNS.'
             FROM chat c JOIN chat_account a ON a.id = c.chat_account_id
             WHERE c.id = :id AND a.owner_id = :owner AND c.left_out = false',
            ['id' => Uuid::fromString($chatId)->toRfc4122(), 'owner' => $owner->getId()->toRfc4122()],
        );
        if (false === $row) {
            throw new NotFoundHttpException('Chat not found.');
        }

        return ['id' => self::text($row['id']), 'row' => $row];
    }

    /**
     * Of these replies, the sent ones the bridge also stored as an own message, by id. Followed as `timeline()` in
     * packages/core/src/chat/format.ts: sent replies with text are matched oldest first, each to the nearest own
     * message not matched yet with the same trimmed text, stored from {@see ECHO_SKEW} seconds before to
     * {@see ECHO_WINDOW} seconds after it went out. Replies sent shortly before the page take part, since they may take a
     * copy a reply on the page would otherwise take.
     *
     * @param list<array<string, mixed>> $replies rows of {@see ChatViews::OUTGOING_COLUMNS}
     *
     * @return array<string, true>
     */
    private function storedReplies(Uuid $owner, string $chatId, array $replies): array
    {
        $sentAt = [];
        foreach ($replies as $reply) {
            if (ChatOutgoingStatus::Sent->value === $reply['status'] && \is_string($reply['sent_at'])) {
                $sentAt[] = new \DateTimeImmutable($reply['sent_at']);
            }
        }
        if ([] === $sentAt) {
            return [];
        }
        $earliest = min($sentAt);
        $latest = max($sentAt);
        $format = static fn (\DateTimeImmutable $time, int $seconds): string => $time->modify(\sprintf('%+d seconds', $seconds))->format('Y-m-d H:i:s');

        $sent = $this->connection->fetchAllAssociative(
            'SELECT o.id, o.sent_at, o.sealed_text FROM chat_outgoing o
             WHERE o.chat_id = :chat AND o.status = :sent AND o.sent_at BETWEEN :from AND :through
             ORDER BY o.sent_at, o.id',
            ['chat' => $chatId, 'sent' => ChatOutgoingStatus::Sent->value, 'from' => $format($earliest, -self::ECHO_LOOKBACK), 'through' => $format($latest, 0)],
        );
        $copies = $this->connection->fetchAllAssociative(
            'SELECT m.id, m.sent_at, m.sealed_text FROM chat_message m
             WHERE m.chat_id = :chat AND m.from_me = true AND m.sent_at BETWEEN :from AND :through
             ORDER BY m.sent_at, m.id',
            ['chat' => $chatId, 'from' => $format($earliest, -self::ECHO_LOOKBACK - self::ECHO_SKEW), 'through' => $format($latest, self::ECHO_WINDOW)],
        );
        $copies = array_map(fn (array $row): array => [
            'id' => self::text($row['id']),
            'at' => new \DateTimeImmutable(self::text($row['sent_at']))->getTimestamp(),
            'text' => self::trimmed($this->fields->open($owner, ChatField::MessageText, Uuid::fromString(self::text($row['id'])), self::text($row['sealed_text'])) ?? ''),
        ], $copies);

        $used = [];
        $stored = [];
        foreach ($sent as $row) {
            $id = self::text($row['id']);
            $text = self::trimmed($this->fields->open($owner, ChatField::OutgoingText, Uuid::fromString($id), self::text($row['sealed_text'])) ?? '');
            if ('' === $text) {
                continue;
            }
            $at = new \DateTimeImmutable(self::text($row['sent_at']))->getTimestamp();
            $nearest = null;
            $distance = \PHP_INT_MAX;
            foreach ($copies as $copy) {
                $offset = $copy['at'] - $at;
                if (isset($used[$copy['id']]) || $copy['text'] !== $text || $offset < -self::ECHO_SKEW || $offset > self::ECHO_WINDOW) {
                    continue;
                }
                if (abs($offset) < $distance) {
                    $nearest = $copy['id'];
                    $distance = abs($offset);
                }
            }
            if (null !== $nearest) {
                $used[$nearest] = true;
                $stored[$id] = true;
            }
        }

        return $stored;
    }

    /**
     * @param MessageView $message
     */
    private static function matches(string $needle, array $message): bool
    {
        foreach ([$message['text'], $message['mediaName'], $message['sender']['name'] ?? null] as $value) {
            if (null !== $value && str_contains(mb_strtolower($value), $needle)) {
                return true;
            }
        }

        return false;
    }

    /** Whitespace at either end removed, as JavaScript's trim() removes it. */
    private static function trimmed(string $text): string
    {
        return preg_replace('/^[\s\p{Z}\x{FEFF}]+|[\s\p{Z}\x{FEFF}]+$/u', '', $text) ?? $text;
    }

    private static function text(mixed $value): string
    {
        return \is_string($value) ? $value : throw new \UnexpectedValueException('Expected a text column.');
    }
}
