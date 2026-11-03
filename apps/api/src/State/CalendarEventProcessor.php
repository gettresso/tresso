<?php

declare(strict_types=1);

namespace App\State;

use ApiPlatform\Metadata\DeleteOperationInterface;
use ApiPlatform\Metadata\Operation;
use ApiPlatform\State\ProcessorInterface;
use ApiPlatform\Validator\Exception\ValidationException;
use App\ApiResource\CalendarEventResource;
use App\ApiResource\Input\Calendar\AttendeeInput;
use App\ApiResource\Input\Calendar\EventInput;
use App\ApiResource\Input\Calendar\EventResponseInput;
use App\ApiResource\Input\Calendar\ReminderInput;
use App\Calendar\EditRejected;
use App\Calendar\EventChanges;
use App\Calendar\EventEditor;
use App\Calendar\ICalendar\EventTime;
use App\Calendar\ICalendar\InvalidCalendarData;
use App\Calendar\Scheduling\SchedulingFailed;
use App\Entity\Calendar;
use App\Entity\CalendarEvent;
use App\Entity\MailAccount;
use App\Entity\User;
use App\Enum\EditScope;
use App\Enum\ParticipationStatus;
use App\Repository\CalendarEventRepository;
use App\Repository\CalendarRepository;
use App\Repository\MailAccountRepository;
use App\Security\CurrentUser;
use Doctrine\ORM\EntityManagerInterface;
use Sabre\VObject\InvalidDataException;
use Sabre\VObject\Recur\RRuleIterator;
use Sabre\VObject\Recur\MaxInstancesExceededException;
use Symfony\Component\HttpFoundation\RequestStack;
use Symfony\Component\HttpKernel\Exception\NotFoundHttpException;
use Symfony\Component\HttpKernel\Exception\UnprocessableEntityHttpException;
use Symfony\Component\Validator\ConstraintViolation;
use Symfony\Component\Validator\ConstraintViolationList;

/**
 * @implements ProcessorInterface<EventInput|EventResponseInput|CalendarEventResource, CalendarEventResource|null>
 */
final readonly class CalendarEventProcessor implements ProcessorInterface
{
    public function __construct(
        private EntityManagerInterface $entityManager,
        private EventEditor $editor,
        private CalendarRepository $calendars,
        private CalendarEventRepository $events,
        private MailAccountRepository $accounts,
        private CurrentUser $currentUser,
        private RequestStack $requests,
    ) {
    }

    public function process(mixed $data, Operation $operation, array $uriVariables = [], array $context = []): ?CalendarEventResource
    {
        $user = $this->currentUser->get();
        $notify = $this->flag('notify');

        try {
            if ($data instanceof EventInput && !isset($uriVariables['id'])) {
                $calendar = $this->calendar($user, $data->calendarId);
                $changes = self::changes($data);
                $organizer = $this->organizer($user, $data->organizerMailAccountId);

                return CalendarEventResource::fromEntity($this->entityManager->wrapInTransaction(
                    fn (): CalendarEvent => $this->editor->create($calendar, $changes, $organizer, $notify),
                ));
            }

            $event = $this->event($user, $uriVariables['id'] ?? null);
            $scope = EditScope::tryFrom((string) ($this->query('scope') ?? 'all')) ?? EditScope::All;
            $recurrenceId = $this->query('recurrenceId');

            if ($data instanceof EventInput) {
                $calendar = $this->calendar($user, $data->calendarId);
                $changes = self::changes($data);
                $organizer = $this->organizer($user, $data->organizerMailAccountId);

                return CalendarEventResource::fromEntity($this->entityManager->wrapInTransaction(
                    fn (): CalendarEvent => $this->editor->update($event, $changes, $scope, $recurrenceId, $calendar, $notify, $organizer),
                ));
            }

            if ($data instanceof EventResponseInput) {
                return CalendarEventResource::fromEntity($this->entityManager->wrapInTransaction(
                    fn (): CalendarEvent => $this->editor->respond($event, ParticipationStatus::from($data->response), $data->recurrenceId, $data->comment, $data->notify),
                ));
            }

            if ($operation instanceof DeleteOperationInterface) {
                $this->entityManager->wrapInTransaction(fn () => $this->editor->delete($event, $scope, $recurrenceId, $notify));

                return null;
            }
        } catch (EditRejected|SchedulingFailed|InvalidCalendarData $e) {
            throw new UnprocessableEntityHttpException($e->getMessage(), $e);
        } catch (MaxInstancesExceededException $e) {
            throw new UnprocessableEntityHttpException('This series repeats too often. Choose fewer repetitions or an end date.', $e);
        }

        throw new \LogicException(\sprintf('Unexpected input for %s.', $operation->getName()));
    }

    private static function changes(EventInput $input): EventChanges
    {
        try {
            $start = EventTime::fromArray($input->start);
        } catch (\InvalidArgumentException $e) {
            throw self::invalid('start', $e->getMessage());
        }
        try {
            $end = EventTime::fromArray($input->end);
        } catch (\InvalidArgumentException $e) {
            throw self::invalid('end', $e->getMessage());
        }
        if ($start->isDate !== $end->isDate) {
            throw self::invalid('end', 'Start and end must both be dates or both be date-times.');
        }
        $utc = new \DateTimeZone('UTC');
        if ($end->toInstant($utc) < $start->toInstant($utc) || ($start->isDate && $end->toInstant($utc) == $start->toInstant($utc))) {
            throw self::invalid('end', 'The end must be after the start.');
        }
        $recurrence = null === $input->recurrence || '' === trim($input->recurrence) ? null : trim($input->recurrence);
        if (null !== $recurrence) {
            try {
                new RRuleIterator($recurrence, $start->toInstant($utc));
            } catch (InvalidDataException $e) {
                throw self::invalid('recurrence', $e->getMessage());
            }
        }

        return new EventChanges(
            trim($input->summary),
            $input->description,
            trim($input->location),
            $input->url,
            $start,
            $end,
            $recurrence,
            $input->status,
            $input->transparency,
            $input->visibility,
            array_map(static fn (AttendeeInput $attendee): array => $attendee->toArray(), $input->attendees),
            array_map(static fn (ReminderInput $reminder): array => $reminder->toArray(), $input->reminders),
            $input->conferenceUrl,
            $input->useDefaultReminders,
            $input->travelMinutes,
            $input->important,
            $input->conferenceProvider,
        );
    }

    private function calendar(User $user, string $id): Calendar
    {
        return $this->calendars->findOneOwnedBy($user, $id) ?? throw self::invalid('calendarId', 'No calendar with that id.');
    }

    private function organizer(User $user, ?string $id): ?MailAccount
    {
        if (null === $id) {
            return null;
        }

        return $this->accounts->findOneOwnedBy($user, $id) ?? throw self::invalid('organizerMailAccountId', 'No mail account with that id.');
    }

    private function event(User $user, mixed $id): CalendarEvent
    {
        $event = \is_string($id) ? $this->events->findOneOwnedBy($user, $id) : null;

        return $event ?? throw new NotFoundHttpException('Event not found.');
    }

    private function query(string $name): ?string
    {
        $value = $this->requests->getCurrentRequest()?->query->get($name);

        return \is_string($value) && '' !== $value ? $value : null;
    }

    private function flag(string $name): bool
    {
        return !\in_array($this->query($name), ['false', '0'], true);
    }

    private static function invalid(string $path, string $message): ValidationException
    {
        return new ValidationException(new ConstraintViolationList([new ConstraintViolation($message, null, [], null, $path, null)]));
    }
}
