<?php

declare(strict_types=1);

namespace App\Enum;

use App\Brief\DailyBriefDelivery;
use App\Notification\NotificationChannelChoice;

/**
 * The kinds of notification: the calendar's, new mail that needs the user, hand-overs and new WhatsApp messages. The
 * dispatcher and the per-kind channel preferences take any kind name.
 */
enum NotificationKind: string
{
    /** A reminder before (or at) an event. */
    case Reminder = 'reminder';
    /** Time to leave for an event somewhere else. */
    case LeaveNow = 'leave_now';
    /** Who is coming and what was said with them, just before a meeting. */
    case Brief = 'brief';
    /** After a meeting: notes and follow-up. */
    case FollowUp = 'follow_up';
    /** New mail judged `do` or `delegate`, unread in an inbox. */
    case Mail = 'mail';
    /** Nobody replied to a hand-over by its due date (not a calendar notification; sent by the hand-overs). */
    case HandOver = 'hand_over';
    /**
     * A new WhatsApp message, while the chat account's Notify me is on ({@see \App\Chat\ChatNotifier}). The phone only:
     * the desktop that relays notifies itself, and an email would carry the chat's name off the server. Not among the
     * kinds with chosen channels: Notify me is its switch.
     */
    case WhatsApp = 'whatsapp';

    /**
     * The kinds whose channels the user chooses per kind (channelsByKind). Reminders carry their own channels, so they
     * are not among them; other features add their kinds here (mail, the daily brief).
     *
     * @return list<string>
     */
    public static function withChosenChannels(): array
    {
        return [self::LeaveNow->value, self::Brief->value, self::FollowUp->value, self::Mail->value, self::HandOver->value, DailyBriefDelivery::KIND];
    }

    /** Where this kind goes unless the user chose otherwise. Reminders carry their own channels. */
    public function defaultChannels(): NotificationChannelChoice
    {
        return match ($this) {
            self::Reminder, self::Mail, self::HandOver => new NotificationChannelChoice(NotificationChannel::Phone, NotificationChannel::Desktop),
            self::LeaveNow, self::WhatsApp => new NotificationChannelChoice(NotificationChannel::Phone),
            self::Brief, self::FollowUp => new NotificationChannelChoice(NotificationChannel::Desktop),
        };
    }
}
