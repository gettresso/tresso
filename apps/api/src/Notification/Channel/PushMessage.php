<?php

declare(strict_types=1);

namespace App\Notification\Channel;

/**
 * What every channel shows: a title and body, where a tap leads, and whether it may make a sound. Any feature can
 * send one; the id is what clients dismiss it by.
 */
final readonly class PushMessage
{
    /** The Android channel of calendar notifications. */
    public const string REMINDERS = 'reminders';
    /** The Android channel of mail notifications. */
    public const string MAIL = 'mail';
    /** The Android channel of new WhatsApp messages (the chat's name only). */
    public const string WHATSAPP = 'whatsapp';
    /**
     * Silent deliveries (quiet hours, focus) go to the channel's silent twin, "reminders_silent", "mail_silent" or
     * "whatsapp_silent": on Android the channel, not the message, decides sound and banner.
     */
    public const string SILENT_SUFFIX = '_silent';

    /**
     * @param string|null           $path a path in the app (/calendar/events/{id}?occurrence=..., /thread/{id},
     *                                    /chats/{id}), or null to open the app as it is
     * @param array<string, string> $data           more for the client to read, next to the fixed keys
     * @param string                $androidChannel the Android notification channel the phone shows it in; the phone
     *                                              creates "reminders" (calendar), "mail" and "whatsapp", and their
     *                                              silent twins
     */
    public function __construct(
        public string $id,
        public string $kind,
        public string $title,
        public string $body,
        public ?string $path,
        public bool $silent,
        /** Push services drop it when it could not be delivered by then. */
        public \DateTimeImmutable $expiresAt,
        public array $data = [],
        public string $androidChannel = self::REMINDERS,
    ) {
    }

    /**
     * The same message, naming the user it is for (data.userId): a browser shows a push only for the user who turned
     * notifications on there. The dispatcher adds it to every push, so no feature has to.
     */
    public function forUser(string $userId): self
    {
        return new self($this->id, $this->kind, $this->title, $this->body, $this->path, $this->silent, $this->expiresAt, [...$this->data, 'userId' => $userId], $this->androidChannel);
    }

    /**
     * @return array<string, mixed>
     */
    public function payload(): array
    {
        return [...$this->data, 'id' => $this->id, 'kind' => $this->kind, 'title' => $this->title, 'body' => $this->body, 'path' => $this->path, 'silent' => $this->silent];
    }

    /** The Android channel this message goes to: its silent twin when it must not make a sound. */
    public function channelOnAndroid(): string
    {
        return $this->silent ? $this->androidChannel.self::SILENT_SUFFIX : $this->androidChannel;
    }
}
