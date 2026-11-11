<?php

declare(strict_types=1);

namespace App\Calendar\Scheduling;

use App\Calendar\ICalendar\CalendarDocument;
use App\Calendar\ICalendar\EventReader;
use App\Calendar\ICalendar\Props;
use App\Entity\MailAccount;
use App\Entity\Message;
use App\Entity\User;
use App\Enum\ItipMethod;
use App\Enum\ParticipationStatus;
use App\Outbox\CalendarPart;
use App\Outbox\Composition;
use App\Outbox\Outbox;
use App\Repository\MailAccountRepository;
use Sabre\VObject\Component\VCalendar;
use Sabre\VObject\Component\VEvent;
use Sabre\VObject\ITip\Message as ItipMessage;

/**
 * Sends iTIP messages by mail (iMIP) through the outbox: invitations and updates to attendees, cancellations, and
 * replies to organizers. Used for calendars whose provider does not schedule by itself.
 */
final readonly class ItipMailer
{
    public function __construct(
        private Outbox $outbox,
        private MailAccountRepository $accounts,
    ) {
    }

    /**
     * Queues every message that matters to its recipient: replies and cancellations always, requests when the
     * event changed in a way attendees must know (time, place, recurrence, status, or they are new; see
     * EventEditor::SIGNIFICANT, which the broker is given).
     *
     * @param list<ItipMessage> $messages
     *
     * @throws SchedulingFailed when none of the user's accounts has the sender's address
     */
    public function send(User $user, array $messages, ?Message $inReplyTo = null): int
    {
        $sent = 0;
        foreach ($messages as $message) {
            if ('REQUEST' === $message->method && !$message->significantChange) {
                continue;
            }
            // A reply goes from the account the invitation came to when no account sends as the invited address
            // (an alias, or the sign-in address).
            $account = $this->account($user, Props::address($message->sender), 'REPLY' === $message->method ? $inReplyTo?->getMailAccount() : null);
            $method = ItipMethod::tryFrom($message->method);
            if (null === $method) {
                continue;
            }
            $calendar = $message->message;
            $event = CalendarDocument::events($calendar)[0] ?? null;
            if (null === $event) {
                continue;
            }

            $this->outbox->queue(new Composition(
                $account,
                [['address' => Props::address($message->recipient), 'name' => self::name($message->recipientName)]],
                [],
                [],
                self::subject($method, $event, $message, $account),
                self::body($method, $event, $calendar, $message, $account),
                null !== $inReplyTo && $inReplyTo->getMailAccount()->getId()->equals($account->getId()) ? $inReplyTo : null,
                new \DateTimeImmutable(),
                calendar: new CalendarPart($method, $calendar->serialize()),
            ), new \DateTimeImmutable());
            ++$sent;
        }

        return $sent;
    }

    private function account(User $user, string $address, ?MailAccount $fallback): MailAccount
    {
        foreach ($this->accounts->findOwnedBy($user) as $account) {
            if (mb_strtolower($account->getEmailAddress()) === $address) {
                return $account;
            }
        }
        if (null !== $fallback) {
            return $fallback;
        }

        throw new SchedulingFailed(\sprintf('None of your mail accounts sends as %s, so the calendar message cannot be sent.', $address));
    }

    private static function subject(ItipMethod $method, VEvent $event, ItipMessage $message, MailAccount $account): string
    {
        $summary = Props::text($event, 'SUMMARY') ?? '(no title)';

        return match ($method) {
            ItipMethod::Reply => self::replyStatus($event, $account)->replyLabel().': '.$summary,
            ItipMethod::Cancel => 'Cancelled: '.$summary,
            default => ($message->sequence > 0 ? 'Updated invitation: ' : 'Invitation: ').$summary,
        };
    }

    private static function body(ItipMethod $method, VEvent $event, VCalendar $calendar, ItipMessage $message, MailAccount $account): string
    {
        $summary = Props::text($event, 'SUMMARY') ?? '(no title)';
        $who = $account->getDisplayName();
        $intro = match ($method) {
            ItipMethod::Reply => \sprintf('%s: %s.', self::replyStatus($event, $account)->replyLabel(), $who),
            ItipMethod::Cancel => \sprintf('%s cancelled this event.', $who),
            default => \sprintf('%s invites you to this event.', $who),
        };

        $lines = ['<p>'.htmlspecialchars($intro).'</p>', '<p><strong>'.htmlspecialchars($summary).'</strong><br>'.htmlspecialchars(self::when($event, $calendar)).'</p>'];
        $location = Props::text($event, 'LOCATION');
        if (null !== $location) {
            $lines[] = '<p>'.htmlspecialchars($location).'</p>';
        }
        $comment = Props::text($event, 'COMMENT');
        if (null !== $comment) {
            $lines[] = '<blockquote>'.nl2br(htmlspecialchars($comment)).'</blockquote>';
        }
        $description = ItipMethod::Request === $method ? Props::text($event, 'DESCRIPTION') : null;
        if (null !== $description) {
            $lines[] = '<p>'.nl2br(htmlspecialchars($description)).'</p>';
        }

        return implode("\n", $lines);
    }

    private static function when(VEvent $event, VCalendar $calendar): string
    {
        $start = Props::dateTime($event, 'DTSTART');
        if (null === $start) {
            return '';
        }
        $time = EventReader::time($start, $calendar);
        if ($time->isDate) {
            return $time->toInstant(new \DateTimeZone('UTC'))->format('l j F Y');
        }
        $value = $time->toInstant(new \DateTimeZone('UTC'));

        return $value->format('l j F Y, H:i').(null === $time->timeZone ? '' : ' ('.$time->timeZone.')');
    }

    private static function replyStatus(VEvent $event, MailAccount $account): ParticipationStatus
    {
        foreach (Props::all($event, 'ATTENDEE') as $attendee) {
            if (Props::address(Props::value($attendee)) === $account->getEmailAddress()) {
                return ParticipationStatus::fromICalendar(Props::param($attendee, 'PARTSTAT'));
            }
        }

        return ParticipationStatus::NeedsAction;
    }

    private static function name(mixed $name): ?string
    {
        $name = \is_string($name) ? trim($name) : '';

        return '' === $name ? null : $name;
    }
}
