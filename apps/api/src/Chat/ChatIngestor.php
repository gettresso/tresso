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
 * - Every message's chat must be in the batch or on the server already (422 otherwise).
 * - A chat is made with its first stored message; a chat of the batch without new messages only renames a known one.
 * - A message of a chat the user left out, or of a group while the account leaves groups out, is not stored
 *   (`left_out`); nothing of such a chat is kept, not even its name.
 * - A chat's last message time only moves forward. During the first import (`firstImport`) its read time moves to the
 *   newest message stored, so the history arrives read.
 * - Names come from other people: control characters and direction overrides are removed, whitespace becomes one
 *   space, and they are cut to {@see MAX_NAME} characters.
 */
final readonly class ChatIngestor
{
    public const int MAX_NAME = 255;

    public function __construct(
        private EntityManagerInterface $entityManager,
        private Connection $connection,
        private ChatRepository $chats,
        private ChatFields $fields,
    ) {
    }

    public function ingest(ChatAccount $account, RelayMessages $batch): RelayImportOutput
    {
        $owner = $account->getOwner()->getId();

        /** @var array<string, RelayChat> $named the chats of the request, by canonical JID */
        $named = [];
        foreach ($batch->chats as $chat) {
            $named[self::canonical($chat->jid)->canonical()] = $chat;
        }
        /** @var list<ChatJid> $addresses the chat of each message, in request order */
        $addresses = array_map(static fn (RelayMessage $message): ChatJid => self::canonical($message->chatJid), $batch->messages);

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
        foreach ($batch->messages as $i => $message) {
            $fingerprints[$i] = $this->fields->messageFingerprint($owner, $addresses[$i]->canonical(), $message->waId);
        }
        $stored = $this->storedFingerprints(array_values($known), $fingerprints);

        $results = [];
        /** @var array<string, Chat> $made */
        $made = [];
        /** @var array<string, array{Chat, \DateTimeImmutable}> $newest */
        $newest = [];
        foreach ($batch->messages as $i => $message) {
            $jid = $addresses[$i]->canonical();
            $chat = $known[$jid] ?? $made[$jid] ?? null;
            if (!$this->taken($account, $addresses[$i]->kind) || (null !== $chat && $chat->isLeftOut())) {
                $results[] = RelayImportOutput::LEFT_OUT;
                continue;
            }
            if (isset($stored[$fingerprints[$i]])) {
                $results[] = RelayImportOutput::KNOWN;
                continue;
            }

            $sentAt = ChatTime::stored($message->sentAt ?? throw new \LogicException('Validation guarantees a time.'));
            if (null === $chat) {
                $chat = $made[$jid] = $this->fields->newChat($account, $jid, self::label($named[$jid]->name ?? null), $addresses[$i]->kind, $sentAt);
                $this->entityManager->persist($chat);
            }
            $this->entityManager->persist($this->fields->newMessage(
                $chat,
                $message->waId,
                $message->fromMe,
                $sentAt,
                null === $message->sender ? null : ['id' => $message->sender->id, 'name' => self::label($message->sender->name)],
                $message->text,
                $message->media?->kind,
                null === $message->media ? null : self::label($message->media->name),
                $message->media?->size,
            ));
            $stored[$fingerprints[$i]] = true;
            $newest[$jid] = [$chat, ChatTime::later($newest[$jid][1] ?? null, $sentAt)];
            $results[] = RelayImportOutput::STORED;
        }

        foreach ($newest as [$chat, $at]) {
            $chat->messageAt($at);
            if ($batch->firstImport) {
                $chat->readThrough($at);
            }
        }
        $this->entityManager->flush();

        $counts = array_count_values($results);

        return new RelayImportOutput(
            $counts[RelayImportOutput::STORED] ?? 0,
            $counts[RelayImportOutput::KNOWN] ?? 0,
            $counts[RelayImportOutput::LEFT_OUT] ?? 0,
            $results,
        );
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

    private static function canonical(#[\SensitiveParameter] string $jid): ChatJid
    {
        return ChatJid::parse($jid) ?? throw new \LogicException('Validation guarantees a chat JID.');
    }
}
