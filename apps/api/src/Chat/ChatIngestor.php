<?php

declare(strict_types=1);

namespace App\Chat;

use ApiPlatform\Validator\Exception\ValidationException;
use App\ApiResource\Input\Chat\RelayChat;
use App\ApiResource\Input\Chat\RelayMessage;
use App\ApiResource\Input\Chat\RelayMessages;
use App\ApiResource\Output\Chat\RelayImportOutput;
use App\Entity\Chat;
use App\Entity\ChatAccount;
use App\Entity\ChatMessage;
use App\Enum\ChatKind;
use App\Repository\ChatRepository;
use Doctrine\DBAL\Connection;
use Doctrine\ORM\EntityManagerInterface;
use Symfony\Component\Validator\ConstraintViolation;
use Symfony\Component\Validator\ConstraintViolationList;

/**
 * Stores a batch of messages the relay read from the bridge's store, under the account it relays. Safe to repeat:
 * a chat is known by the fingerprint of its JID and a message by the fingerprint of its chat's JID and WhatsApp id
 * ({@see ChatFields}), so a message the server has is reported `known` and left as it is, also when it comes twice in
 * one batch. The caller runs it in one transaction: a batch is stored whole or not at all.
 *
 * Every message gets a result, in the order of the request:
 *
 * - `stored`: new, stored.
 * - `known`: the server has it; nothing changed.
 * - `left_out`: its chat is left out, or is a group while the account leaves groups out; not stored.
 * - `refused`: the relay copied something it cannot repair from the bridge's store (a JID that is not a chat Tresso
 *   takes, a WhatsApp or sender id other than 1 to 128 visible ASCII characters, a time before 2009 or more than a day
 *   ahead); not stored. The rest of the batch is, so one bad row never holds the relay's cursor.
 *
 * Further:
 *
 * - Every other message's chat must be in the batch or on the server already (422 otherwise: the relay's own bug).
 * - A chat is made with its first stored message; a chat of the batch without new messages only renames a known one.
 *   A left-out chat keeps its row (the relay must know to leave it out) and is not renamed.
 * - A chat's last message time only moves forward.
 * - `firstImport` is honoured while the account's relay imports the history it found when it started: until its first
 *   batch without it, and again for a relay that takes over. Then the read time of a chat that had nothing unread
 *   (made in this import, or read through its last message) moves to its newest message, so the history arrives read;
 *   a chat with unread messages (also one never read) is left as it is.
 * - Names come from other people: control characters and direction overrides are removed, whitespace becomes one
 *   space, and they are cut to {@see MAX_NAME} characters.
 * - The messages get a change number per {@see CHANGE_BYTES} of text, so a page of the delta, which never splits a
 *   change number, stays bounded however large the batch.
 * - Each chat's newest incoming message stored goes to {@see ChatNotifier} for a push (only with Notify me on, never
 *   for a batch of a first import).
 */
final readonly class ChatIngestor
{
    public const int MAX_NAME = 255;

    /** Text and names stored under one change number, at most (a message larger than that has one of its own). */
    public const int CHANGE_BYTES = 1024 * 1024;

    /** A WhatsApp id or a sender's id: what the bridge stores, visible ASCII. */
    private const string ID = '/^[\x21-\x7E]{1,128}$/D';

    public function __construct(
        private EntityManagerInterface $entityManager,
        private Connection $connection,
        private ChatRepository $chats,
        private ChatFields $fields,
        private ChatNotifier $notifier,
    ) {
    }

    public function ingest(ChatAccount $account, RelayMessages $batch, \DateTimeImmutable $now): RelayImportOutput
    {
        $owner = $account->getOwner()->getId();
        $honourFirstImport = $batch->firstImport && $account->importsHistory();
        if (!$batch->firstImport && $account->importsHistory()) {
            $account->finishHistoryImport();
        }

        /** @var array<string, RelayChat> $named the chats of the request that Tresso takes, by canonical JID */
        $named = [];
        foreach ($batch->chats as $chat) {
            $address = ChatJid::parse($chat->jid);
            if (null !== $address) {
                $named[$address->canonical()] = $chat;
            }
        }
        /** @var array<int, ChatJid> $addresses the chat of each message the relay sent fit to store, by request index */
        $addresses = [];
        foreach ($batch->messages as $i => $message) {
            $address = self::fit($message, $now);
            if (null !== $address) {
                $addresses[$i] = $address;
            }
        }

        $known = $this->knownChats($account, array_values(array_unique([...array_keys($named), ...array_map(static fn (ChatJid $address): string => $address->canonical(), $addresses)])));

        $violations = new ConstraintViolationList();
        foreach ($addresses as $i => $address) {
            if (!isset($named[$address->canonical()]) && !isset($known[$address->canonical()])) {
                // The value is not repeated: nothing a client sends about a chat is echoed back.
                $violations->add(new ConstraintViolation('This chat is neither in the request nor on the server.', null, [], $batch, \sprintf('messages[%d].chatJid', $i), null));
            }
        }
        if (\count($violations) > 0) {
            throw new ValidationException($violations);
        }

        foreach ($named as $jid => $input) {
            $chat = $known[$jid] ?? null;
            if (null !== $chat && !$chat->isLeftOut() && $this->taken($account, $chat->getKind())) {
                $this->fields->rename($chat, self::label($input->name));
            }
        }

        $fingerprints = [];
        foreach ($addresses as $i => $address) {
            $fingerprints[$i] = $this->fields->messageFingerprint($owner, $address->canonical(), $batch->messages[$i]->waId);
        }
        $stored = $this->storedFingerprints(array_values($known), $fingerprints);
        /** @var array<string, bool> $nothingUnread whether a chat had no unread messages before this batch */
        $nothingUnread = [];
        foreach ($known as $jid => $chat) {
            $read = $chat->getReadThrough();
            // A known chat that was never read has unread messages (it has messages); one read through its last has none.
            $nothingUnread[$jid] = null !== $read && $read >= $chat->getLastMessageAt();
        }

        $results = [];
        /** @var array<string, Chat> $made */
        $made = [];
        /** @var array<string, array{Chat, \DateTimeImmutable}> $newest */
        $newest = [];
        /** @var array<string, ChatMessage> $newestIncoming the newest incoming message stored per chat, for a push */
        $newestIncoming = [];
        $bytes = 0;
        foreach ($batch->messages as $i => $message) {
            $address = $addresses[$i] ?? null;
            if (null === $address) {
                $results[] = RelayImportOutput::REFUSED;
                continue;
            }
            $jid = $address->canonical();
            $chat = $known[$jid] ?? $made[$jid] ?? null;
            if (!$this->taken($account, $address->kind) || (null !== $chat && $chat->isLeftOut())) {
                $results[] = RelayImportOutput::LEFT_OUT;
                continue;
            }
            if (isset($stored[$fingerprints[$i]])) {
                $results[] = RelayImportOutput::KNOWN;
                continue;
            }

            $sentAt = ChatTime::stored($message->sentAt ?? throw new \LogicException('Validation guarantees a time.'));
            $size = \strlen($message->text) + \strlen((string) $message->sender?->name) + \strlen((string) $message->media?->name);
            if ($bytes > 0 && $bytes + $size > self::CHANGE_BYTES) {
                // What is persisted so far gets its change number; the rest gets the next.
                $this->entityManager->flush();
                $bytes = 0;
            }
            $bytes += $size;
            if (null === $chat) {
                $chat = $made[$jid] = $this->fields->newChat($account, $jid, self::label($named[$jid]->name ?? null), $address->kind, $sentAt);
                $this->entityManager->persist($chat);
                $nothingUnread[$jid] = true;
            }
            $row = $this->fields->newMessage(
                $chat,
                $message->waId,
                $message->fromMe,
                $sentAt,
                null === $message->sender ? null : ['id' => $message->sender->id, 'name' => self::label($message->sender->name)],
                $message->text,
                $message->media?->kind,
                null === $message->media ? null : self::label($message->media->name),
                $message->media?->size,
            );
            $this->entityManager->persist($row);
            if (!$message->fromMe && (!isset($newestIncoming[$jid]) || $newestIncoming[$jid]->getSentAt() <= $sentAt)) {
                $newestIncoming[$jid] = $row;
            }
            $stored[$fingerprints[$i]] = true;
            $newest[$jid] = [$chat, ChatTime::later($newest[$jid][1] ?? null, $sentAt)];
            $results[] = RelayImportOutput::STORED;
        }

        foreach ($newest as $jid => [$chat, $at]) {
            $chat->messageAt($at);
            if ($honourFirstImport && ($nothingUnread[$jid] ?? false)) {
                $chat->readThrough($at);
            }
        }
        $this->entityManager->flush();
        $this->notifier->stored($account, array_values($newestIncoming), $batch->firstImport, $now);

        $counts = array_count_values($results);

        return new RelayImportOutput(
            $counts[RelayImportOutput::STORED] ?? 0,
            $counts[RelayImportOutput::KNOWN] ?? 0,
            $counts[RelayImportOutput::LEFT_OUT] ?? 0,
            $counts[RelayImportOutput::REFUSED] ?? 0,
            $results,
        );
    }

    /**
     * The chat of a message the relay sent, when the message is fit to store; null when it carries something the relay
     * cannot repair.
     */
    private static function fit(RelayMessage $message, \DateTimeImmutable $now): ?ChatJid
    {
        $sentAt = $message->sentAt;
        $fit = null !== $sentAt
            && $sentAt >= new \DateTimeImmutable(ChatTime::EARLIEST)
            && $sentAt <= $now->modify(ChatTime::MAX_AHEAD)
            && 1 === preg_match(self::ID, $message->waId)
            && (null === $message->sender || 1 === preg_match(self::ID, $message->sender->id));

        return $fit ? ChatJid::parse($message->chatJid) : null;
    }

    /**
     * A name from WhatsApp fit to store: whitespace (line breaks too) one space, control characters and direction
     * overrides, embeddings and isolates removed, trimmed, cut to {@see MAX_NAME} characters; null when nothing is left.
     */
    public static function label(#[\SensitiveParameter] ?string $name): ?string
    {
        if (null === $name) {
            return null;
        }
        $name = preg_replace(['/\s+/u', '/[\p{Cc}\x{202A}-\x{202E}\x{2066}-\x{2069}]/u'], [' ', ''], $name) ?? throw new \UnexpectedValueException('A name is not valid UTF-8.');
        $name = trim(mb_substr(trim($name), 0, self::MAX_NAME));

        return '' === $name ? null : $name;
    }

    private function taken(ChatAccount $account, ChatKind $kind): bool
    {
        return ChatKind::Group !== $kind || $account->includesGroups();
    }

    /**
     * The account's chats with these JIDs, by JID.
     *
     * @param list<string> $jids canonical
     *
     * @return array<string, Chat>
     */
    private function knownChats(ChatAccount $account, array $jids): array
    {
        if ([] === $jids) {
            return [];
        }
        $owner = $account->getOwner()->getId();
        $byFingerprint = [];
        foreach ($jids as $jid) {
            $byFingerprint[$this->fields->jidFingerprint($owner, $jid)] = $jid;
        }
        $known = [];
        foreach ($this->chats->findBy(['chatAccount' => $account, 'jidFingerprint' => array_keys($byFingerprint)]) as $chat) {
            $known[$byFingerprint[$chat->getJidFingerprint()]] = $chat;
        }

        return $known;
    }

    /**
     * Which of these message fingerprints the chats have stored already.
     *
     * @param list<Chat>         $chats
     * @param array<int, string> $fingerprints
     *
     * @return array<string, true>
     */
    private function storedFingerprints(array $chats, array $fingerprints): array
    {
        if ([] === $chats || [] === $fingerprints) {
            return [];
        }
        $found = $this->connection->fetchFirstColumn(
            'SELECT wa_fingerprint FROM chat_message WHERE chat_id = ANY(CAST(:chats AS UUID[])) AND wa_fingerprint = ANY(CAST(:fingerprints AS TEXT[]))',
            [
                'chats' => '{'.implode(',', array_map(static fn (Chat $chat): string => $chat->getId()->toRfc4122(), $chats)).'}',
                'fingerprints' => '{'.implode(',', array_unique($fingerprints)).'}',
            ],
        );

        return array_fill_keys(array_map(static fn (mixed $fingerprint): string => \is_string($fingerprint) ? $fingerprint : throw new \UnexpectedValueException('Expected a fingerprint.'), $found), true);
    }
}
