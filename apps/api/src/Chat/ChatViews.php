<?php

declare(strict_types=1);

namespace App\Chat;

use App\Entity\Chat;
use App\Entity\ChatAccount;
use App\Entity\ChatOutgoing;
use Symfony\Component\Uid\Uuid;

/**
 * What clients get of a chat account, chat, chat message and reply, with the sealed fields opened: the one shape for
 * the delta (from rows read in SQL) and for the REST resources (from entities). Times are ATOM strings.
 *
 * @phpstan-type AccountView array{id: string, channel: string, address: ?string, displayName: ?string, relayDeviceId: string, relayDeviceName: string, relayOnline: bool, relayOfflineSince: ?string, bridge: string, link: string, linkedAt: ?string, loopbackOnly: ?bool, includeGroups: bool, notify: bool}
 * @phpstan-type ChatView array{id: string, chatAccountId: string, jid: string, name: ?string, kind: string, lastMessageAt: string, readThrough: ?string, archivedThrough: ?string, leftOut: bool}
 * @phpstan-type MessageView array{id: string, chatId: string, chatAccountId: string, waId: string, fromMe: bool, sentAt: string, sender: array{id: string, name: ?string}|null, text: string, mediaKind: ?string, mediaName: ?string, mediaSize: ?int}
 * @phpstan-type OutgoingView array{id: string, chatId: string, chatAccountId: string, text: string, status: string, error: ?string, createdAt: string, claimedAt: ?string, sentAt: ?string}
 */
final readonly class ChatViews
{
    /** The columns {@see accountRow()} reads, as `a`. */
    public const string ACCOUNT_COLUMNS = 'a.id, a.channel, a.sealed_address, a.sealed_display_name, a.relay_device_id, a.relay_device_name, a.relay_online,
        a.relay_offline_since, a.bridge_state, a.link_state, a.linked_at, a.loopback_only, a.include_groups, a.notify';

    /** The columns {@see chatRow()} reads, as `c`. */
    public const string CHAT_COLUMNS = 'c.id, c.chat_account_id, c.sealed_jid, c.sealed_name, c.kind, c.last_message_at, c.read_through, c.archived_through, c.left_out';

    /** The columns {@see messageRow()} reads, as `m`. */
    public const string MESSAGE_COLUMNS = 'm.id, m.chat_id, m.chat_account_id, m.sealed_wa_id, m.from_me, m.sent_at, m.sealed_sender, m.sealed_text, m.media_kind,
        m.sealed_media_name, m.media_size';

    /** The columns {@see outgoingRow()} reads, as `o`. */
    public const string OUTGOING_COLUMNS = 'o.id, o.chat_id, o.chat_account_id, o.sealed_text, o.status, o.error, o.created_at, o.claimed_at, o.sent_at';

    public function __construct(private ChatFields $fields)
    {
    }

    /**
     * @return AccountView
     */
    public function account(ChatAccount $account): array
    {
        return [
            'id' => $account->getId()->toRfc4122(),
            'channel' => $account->getChannel()->value,
            'address' => $this->fields->accountAddress($account),
            'displayName' => $this->fields->accountDisplayName($account),
            'relayDeviceId' => $account->getRelayDeviceId()->toRfc4122(),
            'relayDeviceName' => $account->getRelayDeviceName(),
            'relayOnline' => $account->isRelayOnline(),
            'relayOfflineSince' => self::date($account->getRelayOfflineSince()),
            'bridge' => $account->getBridgeState()->value,
            'link' => $account->getLinkState()->value,
            'linkedAt' => self::date($account->getLinkedAt()),
            'loopbackOnly' => $account->isLoopbackOnly(),
            'includeGroups' => $account->includesGroups(),
            'notify' => $account->notifies(),
        ];
    }

    /**
     * @param array<string, mixed> $row {@see ACCOUNT_COLUMNS}
     *
     * @return AccountView
     */
    public function accountRow(Uuid $owner, array $row): array
    {
        $id = Uuid::fromString(self::text($row['id']));

        return [
            'id' => $id->toRfc4122(),
            'channel' => self::text($row['channel']),
            'address' => $this->fields->open($owner, ChatField::AccountAddress, $id, self::nullableText($row['sealed_address'])),
            'displayName' => $this->fields->open($owner, ChatField::AccountName, $id, self::nullableText($row['sealed_display_name'])),
            'relayDeviceId' => Uuid::fromString(self::text($row['relay_device_id']))->toRfc4122(),
            'relayDeviceName' => self::text($row['relay_device_name']),
            'relayOnline' => (bool) $row['relay_online'],
            'relayOfflineSince' => self::date($row['relay_offline_since']),
            'bridge' => self::text($row['bridge_state']),
            'link' => self::text($row['link_state']),
            'linkedAt' => self::date($row['linked_at']),
            'loopbackOnly' => null === $row['loopback_only'] ? null : (bool) $row['loopback_only'],
            'includeGroups' => (bool) $row['include_groups'],
            'notify' => (bool) $row['notify'],
        ];
    }

    /**
     * @return ChatView
     */
    public function chat(Chat $chat): array
    {
        return [
            'id' => $chat->getId()->toRfc4122(),
            'chatAccountId' => $chat->getChatAccount()->getId()->toRfc4122(),
            'jid' => $this->fields->jid($chat),
            'name' => $this->fields->name($chat),
            'kind' => $chat->getKind()->value,
            'lastMessageAt' => self::requiredDate($chat->getLastMessageAt()),
            'readThrough' => self::date($chat->getReadThrough()),
            'archivedThrough' => self::date($chat->getArchivedThrough()),
            'leftOut' => $chat->isLeftOut(),
        ];
    }

    /**
     * @return OutgoingView
     */
    public function outgoing(ChatOutgoing $outgoing): array
    {
        return [
            'id' => $outgoing->getId()->toRfc4122(),
            'chatId' => $outgoing->getChat()->getId()->toRfc4122(),
            'chatAccountId' => $outgoing->getChatAccount()->getId()->toRfc4122(),
            'text' => $this->fields->outgoingText($outgoing),
            'status' => $outgoing->getStatus()->value,
            'error' => $outgoing->getError()?->value,
            'createdAt' => self::requiredDate($outgoing->getCreatedAt()),
            'claimedAt' => self::date($outgoing->getClaimedAt()),
            'sentAt' => self::date($outgoing->getSentAt()),
        ];
    }

    /**
     * @param array<string, mixed> $row {@see CHAT_COLUMNS}
     *
     * @return ChatView
     */
    public function chatRow(Uuid $owner, array $row): array
    {
        $id = Uuid::fromString(self::text($row['id']));

        return [
            'id' => $id->toRfc4122(),
            'chatAccountId' => self::text($row['chat_account_id']),
            'jid' => $this->fields->open($owner, ChatField::Jid, $id, self::text($row['sealed_jid'])) ?? throw new \LogicException('A sealed value opens to a value.'),
            'name' => $this->fields->open($owner, ChatField::Name, $id, self::nullableText($row['sealed_name'])),
            'kind' => self::text($row['kind']),
            'lastMessageAt' => self::requiredDate($row['last_message_at']),
            'readThrough' => self::date($row['read_through']),
            'archivedThrough' => self::date($row['archived_through']),
            'leftOut' => (bool) $row['left_out'],
        ];
    }

    /**
     * @param array<string, mixed> $row {@see MESSAGE_COLUMNS}
     *
     * @return MessageView
     */
    public function messageRow(Uuid $owner, array $row): array
    {
        $id = Uuid::fromString(self::text($row['id']));

        return [
            'id' => $id->toRfc4122(),
            'chatId' => self::text($row['chat_id']),
            'chatAccountId' => self::text($row['chat_account_id']),
            'waId' => $this->fields->open($owner, ChatField::MessageWaId, $id, self::text($row['sealed_wa_id'])) ?? throw new \LogicException('A sealed value opens to a value.'),
            'fromMe' => (bool) $row['from_me'],
            'sentAt' => self::requiredDate($row['sent_at']),
            'sender' => ChatFields::decodeSender($this->fields->open($owner, ChatField::MessageSender, $id, self::nullableText($row['sealed_sender']))),
            'text' => $this->fields->open($owner, ChatField::MessageText, $id, self::text($row['sealed_text'])) ?? throw new \LogicException('A sealed value opens to a value.'),
            'mediaKind' => self::nullableText($row['media_kind']),
            'mediaName' => $this->fields->open($owner, ChatField::MessageMedia, $id, self::nullableText($row['sealed_media_name'])),
            'mediaSize' => null === $row['media_size'] ? null : self::int($row['media_size']),
        ];
    }

    /**
     * @param array<string, mixed> $row {@see OUTGOING_COLUMNS}
     *
     * @return OutgoingView
     */
    public function outgoingRow(Uuid $owner, array $row): array
    {
        $id = Uuid::fromString(self::text($row['id']));

        return [
            'id' => $id->toRfc4122(),
            'chatId' => self::text($row['chat_id']),
            'chatAccountId' => self::text($row['chat_account_id']),
            'text' => $this->fields->open($owner, ChatField::OutgoingText, $id, self::text($row['sealed_text'])) ?? throw new \LogicException('A sealed value opens to a value.'),
            'status' => self::text($row['status']),
            'error' => self::nullableText($row['error']),
            'createdAt' => self::requiredDate($row['created_at']),
            'claimedAt' => self::date($row['claimed_at']),
            'sentAt' => self::date($row['sent_at']),
        ];
    }

    /** Stored without a zone and read in the default one, as the ORM reads it: entities and SQL rows give one string. */
    /** A NOT NULL column: always a time. */
    private static function requiredDate(mixed $value): string
    {
        return self::date($value) ?? throw new \UnexpectedValueException('Expected a time from the database.');
    }

    private static function date(mixed $value): ?string
    {
        if ($value instanceof \DateTimeInterface) {
            return $value->format(\DATE_ATOM);
        }

        return \is_string($value) ? new \DateTimeImmutable($value)->format(\DATE_ATOM) : null;
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
}
