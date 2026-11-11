<?php

declare(strict_types=1);

namespace App\State;

use ApiPlatform\Metadata\Operation;
use ApiPlatform\State\ProviderInterface;
use App\ApiResource\CalendarOccurrence;
use App\ApiResource\MessageInvitation;
use App\Calendar\ICalendar\CalendarDocument;
use App\Calendar\ICalendar\EventReader;
use App\Calendar\ICalendar\InvalidCalendarData;
use App\Calendar\Invitation\InvitationApplier;
use App\Calendar\OccurrenceExpander;
use App\Calendar\SelfAddresses;
use App\Calendar\TooManyOccurrences;
use App\Entity\CalendarEvent;
use App\Entity\CalendarInvitation;
use App\Entity\Message;
use App\Entity\User;
use App\Enum\ItipMethod;
use App\Enum\Transparency;
use App\Repository\CalendarEventRepository;
use App\Repository\CalendarInvitationRepository;
use App\Repository\CalendarObjectRepository;
use App\Repository\MessageRepository;
use App\Security\CurrentUser;
use Symfony\Component\HttpKernel\Exception\NotFoundHttpException;
use Symfony\Component\HttpKernel\Exception\UnprocessableEntityHttpException;

/**
 * @implements ProviderInterface<MessageInvitation>
 */
final readonly class MessageInvitationProvider implements ProviderInterface
{
    public function __construct(
        private MessageRepository $messages,
        private CalendarInvitationRepository $invitations,
        private CalendarObjectRepository $objects,
        private CalendarEventRepository $events,
        private OccurrenceExpander $expander,
        private SelfAddresses $selfAddresses,
        private CurrentUser $currentUser,
        private InvitationApplier $applier,
    ) {
    }

    public function provide(Operation $operation, array $uriVariables = [], array $context = []): MessageInvitation
    {
        $user = $this->currentUser->get();
        $id = $uriVariables['id'] ?? null;
        $message = \is_string($id) ? $this->messages->findOneOwnedBy($user, $id) : null;
        $invitation = $message instanceof Message ? ($this->invitations->findForMessage($message)[0] ?? null) : null;
        if (!$invitation instanceof CalendarInvitation) {
            throw new NotFoundHttpException('This message carries no calendar event.');
        }

        $self = $this->selfAddresses->of($user);
        $row = $this->storedRow($user, $invitation);
        $itip = CalendarDocument::parse($invitation->getIcal());
        $vevent = CalendarDocument::master($itip) ?? CalendarDocument::events($itip)[0] ?? throw new NotFoundHttpException('This message carries no calendar event.');
        try {
            $data = EventReader::read($vevent, $itip, $self);
        } catch (InvalidCalendarData $e) {
            // A REPLY or CANCEL may leave out the times (RFC 5546 allows it): show the event as the calendar has it.
            $stored = null === $row ? null : CalendarDocument::parse($row->getObject()->getIcal());
            $event = null === $stored ? null : (CalendarDocument::override($stored, $invitation->getRecurrenceKey()) ?? CalendarDocument::master($stored));
            if (null === $stored || null === $event) {
                throw new UnprocessableEntityHttpException('The calendar part of this message cannot be read: '.$e->getMessage(), $e);
            }
            $data = EventReader::read($event, $stored, $self);
        }

        $canApply = null === $invitation->getAppliedAt() && \in_array($invitation->getMethod(), [ItipMethod::Request, ItipMethod::Cancel, ItipMethod::Reply], true) && null === $this->applier->blocker($invitation);
        $stored = null === $row ? null : $row->getSequence();
        $kind = match (true) {
            ItipMethod::Cancel === $invitation->getMethod() => 'cancelled',
            ItipMethod::Reply === $invitation->getMethod() => 'reply',
            null !== $stored && $invitation->getSequence() < $stored => 'outdated',
            $invitation->getSequence() > 0 => 'update',
            default => 'new',
        };

        $conflicts = [];
        if (ItipMethod::Request === $invitation->getMethod() && Transparency::Busy === $data->transparency) {
            $utc = new \DateTimeZone('UTC');
            try {
                $occurrences = $this->expander->expand($user, [], $data->startsAt, max($data->endsAt, $data->startsAt->modify('+1 minute')), $utc);
            } catch (TooManyOccurrences|\InvalidArgumentException) {
                // An event too long (or a calendar too full) to look through gets no conflict hint, rather than no answer.
                $occurrences = [];
            }
            $conflicts = array_values(array_filter($occurrences, static fn (CalendarOccurrence $o): bool => 'busy' === $o->transparency && 'cancelled' !== $o->status && 'declined' !== $o->selfResponse && (null === $row || $o->eventId !== $row->getId()->toRfc4122()) && !$data->isAllDay() && !$o->allDay));
        }

        return new MessageInvitation(
            $invitation->getId()->toRfc4122(),
            $invitation->getMethod()->value,
            $kind,
            $invitation->getUid(),
            '' === $invitation->getRecurrenceKey() ? null : $invitation->getRecurrenceKey(),
            $invitation->getSequence(),
            $data->summary,
            $data->description,
            $data->location,
            $data->isAllDay(),
            $data->start->toArray(),
            $data->end->toArray(),
            $data->rrule,
            $data->organizer,
            $data->attendees,
            $data->conference,
            $row?->getId()->toRfc4122(),
            ($row?->getSelfPartstat() ?? $data->selfPartstat)?->value,
            ItipMethod::Request === $invitation->getMethod() && null !== $row && null !== $row->getSelfPartstat() && 'outdated' !== $kind,
            $conflicts,
            $canApply,
            // Only where the user can act on it: mail the calendar cannot take (a provider schedules) is no question.
            $canApply && $this->applier->senderUnconfirmed($invitation),
        );
    }

    private function storedRow(User $user, CalendarInvitation $invitation): ?CalendarEvent
    {
        // The same object the applier would change.
        $object = InvitationApplier::pick($this->objects->findForOwnerByUid($user, $invitation->getUid()), $invitation->getMessage()->getMailAccount());
        if (null === $object) {
            return null;
        }
        $rows = $this->events->findForObject($object);

        return $rows[$invitation->getRecurrenceKey()] ?? $rows[''] ?? null;
    }
}
