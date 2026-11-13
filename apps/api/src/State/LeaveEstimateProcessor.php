<?php

declare(strict_types=1);

namespace App\State;

use ApiPlatform\Metadata\Operation;
use ApiPlatform\State\ProcessorInterface;
use App\ApiResource\Input\Notification\LeaveEstimateInput;
use App\ApiResource\LeaveEstimateResource;
use App\Entity\ScheduledNotification;
use App\Enum\NotificationKind;
use App\Notification\EventPlace;
use App\Notification\NotificationPlanner;
use App\Notification\Travel\TravelTimeEstimator;
use App\Repository\CalendarEventRepository;
use App\Repository\NotificationPreferencesRepository;
use App\Security\CurrentUser;
use Doctrine\DBAL\LockMode;
use Doctrine\ORM\EntityManagerInterface;
use Symfony\Component\HttpKernel\Exception\NotFoundHttpException;

/**
 * Estimates the travel time from the phone's position to the event's place, by the user's way of travel, and moves
 * the leave-now reminder of that occurrence to the moment to leave. The position is used for this estimate only.
 *
 * @implements ProcessorInterface<LeaveEstimateInput, LeaveEstimateResource>
 */
final readonly class LeaveEstimateProcessor implements ProcessorInterface
{
    public function __construct(
        private EntityManagerInterface $entityManager,
        private CalendarEventRepository $events,
        private NotificationPreferencesRepository $preferences,
        private TravelTimeEstimator $travel,
        private NotificationPlanner $planner,
        private CurrentUser $currentUser,
    ) {
    }

    public function process(mixed $data, Operation $operation, array $uriVariables = [], array $context = []): LeaveEstimateResource
    {
        $user = $this->currentUser->get();
        $id = $uriVariables['id'] ?? null;
        $event = \is_string($id) ? $this->events->findOneOwnedBy($user, $id) : null;
        if (null === $event) {
            throw new NotFoundHttpException('Event not found.');
        }
        $occurrenceKey = $event->isOverride() ? $event->getRecurrenceKey() : ($data->recurrenceId ?? '');
        $notification = $this->entityManager->getRepository(ScheduledNotification::class)->findOneBy(['event' => $event, 'occurrenceKey' => $occurrenceKey, 'kind' => NotificationKind::LeaveNow, 'slot' => NotificationPlanner::LEAVE_ESTIMATED_SLOT]);
        if (null === $notification || $notification->isDelivered() || null !== $notification->getDismissedAt()) {
            throw new NotFoundHttpException('This occurrence has no leave-now reminder waiting for an estimate.');
        }

        // Only the place goes to the geocoder: never a meeting link written in it. A place that is only a link, or only
        // says "online", is nowhere to travel to.
        $place = EventPlace::toTravelTo($event->getLocation());
        if ('' === $place) {
            return new LeaveEstimateResource(null, null);
        }
        $preferences = $this->preferences->forUser($user);
        $minutes = $this->travel->minutes($data->latitude, $data->longitude, $place, $notification->getOccurrenceStartsAt(), $preferences->getTravelMode());
        if (null === $minutes) {
            return new LeaveEstimateResource(null, null);
        }
        $leaveAt = $notification->getOccurrenceStartsAt()->modify(\sprintf('-%d minutes', $minutes + $preferences->getExtraTravelMinutes()));

        $this->entityManager->wrapInTransaction(function () use ($notification, $minutes, $leaveAt, $place): void {
            $locked = $this->entityManager->find(ScheduledNotification::class, $notification->getId(), LockMode::PESSIMISTIC_WRITE);
            if (null === $locked || $locked->isDelivered() || null !== $locked->getDismissedAt()) {
                return;
            }
            $locked->estimate($minutes, $leaveAt, NotificationPlanner::leaveBody($minutes, $place));
            $this->entityManager->flush();
            $this->planner->announce($locked);
        });

        return new LeaveEstimateResource($minutes, $leaveAt);
    }
}
