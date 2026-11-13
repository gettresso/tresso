<?php

declare(strict_types=1);

namespace App\State;

use ApiPlatform\Metadata\DeleteOperationInterface;
use ApiPlatform\Metadata\Operation;
use ApiPlatform\State\ProcessorInterface;
use App\ApiResource\CalendarEventResource;
use App\ApiResource\Input\Calendar\MeetingLinkInput;
use App\Calendar\EditRejected;
use App\Calendar\EventEditor;
use App\Calendar\MeetingLinkPresent;
use App\Calendar\ICalendar\InvalidCalendarData;
use App\Calendar\Scheduling\SchedulingFailed;
use App\Entity\CalendarEvent;
use App\Repository\CalendarEventRepository;
use App\Security\CurrentUser;
use Doctrine\ORM\EntityManagerInterface;
use Symfony\Component\HttpFoundation\RequestStack;
use Symfony\Component\HttpKernel\Exception\ConflictHttpException;
use Symfony\Component\HttpKernel\Exception\NotFoundHttpException;
use Symfony\Component\HttpKernel\Exception\UnprocessableEntityHttpException;

/**
 * POST and DELETE /calendar-events/{id}/meeting-link: asks the calendar's provider for a meeting on the whole series
 * (Retry), or takes the link off it and drops a pending or failed request. `DELETE ...?only=request` drops only the
 * request (Leave without a link) and answers 409 when the series has a link. Only for events the user organizes;
 * `notify=false` keeps updates from going to the guests.
 *
 * @implements ProcessorInterface<MeetingLinkInput|CalendarEventResource, CalendarEventResource>
 */
final readonly class MeetingLinkProcessor implements ProcessorInterface
{
    public function __construct(
        private EntityManagerInterface $entityManager,
        private EventEditor $editor,
        private CalendarEventRepository $events,
        private CurrentUser $currentUser,
        private RequestStack $requests,
    ) {
    }

    public function process(mixed $data, Operation $operation, array $uriVariables = [], array $context = []): CalendarEventResource
    {
        $id = $uriVariables['id'] ?? null;
        $event = \is_string($id) ? $this->events->findOneOwnedBy($this->currentUser->get(), $id) : null;
        if (null === $event) {
            throw new NotFoundHttpException('Event not found.');
        }
        $query = $this->requests->getCurrentRequest()?->query;
        $notify = !\in_array($query?->get('notify'), ['false', '0'], true);
        $requestOnly = 'request' === $query?->get('only');

        try {
            return CalendarEventResource::fromEntity($this->entityManager->wrapInTransaction(
                fn (): CalendarEvent => match (true) {
                    $data instanceof MeetingLinkInput && !$operation instanceof DeleteOperationInterface => $this->editor->requestMeeting($event, $data->provider, $notify),
                    $requestOnly => $this->editor->dropMeetingRequest($event),
                    default => $this->editor->removeMeeting($event, $notify),
                },
            ));
        } catch (MeetingLinkPresent $e) {
            throw new ConflictHttpException($e->getMessage(), $e);
        } catch (EditRejected|SchedulingFailed|InvalidCalendarData $e) {
            throw new UnprocessableEntityHttpException($e->getMessage(), $e);
        }
    }
}
