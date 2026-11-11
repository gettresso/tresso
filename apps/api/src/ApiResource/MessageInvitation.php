<?php

declare(strict_types=1);

namespace App\ApiResource;

use ApiPlatform\Metadata\ApiProperty;
use ApiPlatform\Metadata\ApiResource;
use ApiPlatform\Metadata\Get;
use ApiPlatform\Metadata\Post;
use App\Calendar\ICalendar\EventData;
use App\Security\Scope;
use App\State\MessageInvitationProcessor;
use App\State\MessageInvitationProvider;

/**
 * The calendar object a message carries, as the invitation card shows it: what the event is, whether this message
 * invites, updates, cancels or answers, the user's own response, and what else is in their calendar at that time.
 * `eventId` is the event in the user's calendar, when there is one, for RSVP and opening it.
 *
 * @phpstan-import-type Address from EventData
 * @phpstan-import-type Attendee from EventData
 * @phpstan-import-type Conference from EventData
 */
#[ApiResource(
    shortName: 'MessageInvitation',
    routePrefix: '/api/v1',
    normalizationContext: ['skip_null_values' => false],
    operations: [
        new Get(
            uriTemplate: '/messages/{id}/invitation',
            security: "is_granted('".Scope::ROLE_MAIL_READ."') and is_granted('".Scope::ROLE_CALENDAR_READ."')",
            provider: MessageInvitationProvider::class,
        ),
        // Applies calendar mail the calendar did not take by itself (an invitation, update, cancellation or reply that
        // arrived outside the inbox or before the account was connected), with the same checks as calendar mail that
        // arrives in the inbox.
        new Post(
            uriTemplate: '/messages/{id}/invitation/apply',
            status: 200,
            // Saving the event can make a provider that schedules tell others: mail in the user's name.
            security: "is_granted('".Scope::ROLE_MAIL_READ."') and is_granted('".Scope::ROLE_CALENDAR_WRITE."') and is_granted('".Scope::ROLE_MAIL_SEND."')",
            input: false,
            read: false,
            processor: MessageInvitationProcessor::class,
        ),
    ],
)]
final readonly class MessageInvitation
{
    /**
     * @param array{date: string}|array{dateTime: string, timeZone: ?string} $start
     * @param array{date: string}|array{dateTime: string, timeZone: ?string} $end
     * @param Address|null                                                   $organizer
     * @param list<Attendee>                                                 $attendees
     * @param Conference|null                                                $conference
     * @param list<CalendarOccurrence>                                       $conflicts
     */
    public function __construct(
        #[ApiProperty(identifier: true)]
        public string $id,
        public string $method,
        /** new, update, cancelled, reply or outdated (an older version than the calendar has). */
        public string $kind,
        public string $uid,
        public ?string $recurrenceId,
        public int $sequence,
        public string $summary,
        public string $description,
        public string $location,
        public bool $allDay,
        public array $start,
        public array $end,
        public ?string $recurrence,
        public ?array $organizer,
        public array $attendees,
        public ?array $conference,
        public ?string $eventId,
        public ?string $selfResponse,
        public bool $canRespond,
        public array $conflicts,
        /**
         * Calendar mail the calendar did not take by itself (it arrived outside the inbox or before the account was
         * connected, or there was no calendar to write to): POST .../invitation/apply applies it.
         */
        public bool $canApply,
        /**
         * The mail would change the event, but the receiving provider did not confirm that it comes from its sender
         * (no DMARC pass on a Gmail or Microsoft account): it was not applied by itself, and the user decides.
         */
        public bool $senderUnconfirmed = false,
    ) {
    }
}
