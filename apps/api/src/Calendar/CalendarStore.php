<?php

declare(strict_types=1);

namespace App\Calendar;

use App\Calendar\ICalendar\CalendarDocument;
use App\Calendar\ICalendar\InvalidCalendarData;
use App\Calendar\ICalendar\Occurrences;
use App\Entity\Calendar;
use App\Entity\CalendarEvent;
use App\Entity\CalendarOperation;
use App\Entity\CalendarObject;
use App\Enum\CalendarOperationKind;
use App\Notification\PlanCalendarObject;
use App\Realtime\AfterCommitDispatcher;
use App\Realtime\RealtimeNotifier;
use App\Repository\CalendarOperationRepository;
use App\Todo\TodoReplanning;
use Doctrine\ORM\EntityManagerInterface;
use Sabre\VObject\Component\VCalendar;

/**
 * Saves and removes calendar resources: the iCalendar text, its event rows, and (for changes the user made in a
 * provider calendar) the write the account's worker has to make at the provider. Runs inside the caller's
 * transaction.
 */
final readonly class CalendarStore
{
    public function __construct(
        private EntityManagerInterface $entityManager,
        private EventProjector $projector,
        private CalendarOperationRepository $operations,
        private RealtimeNotifier $notifier,
        private AfterCommitDispatcher $afterCommit,
        private TodoReplanning $todoReplanning,
    ) {
    }

    /**
     * @param bool        $fromProvider the data came from the provider, so nothing has to be written back
     * @param bool        $notify       a provider that schedules tells attendees (or the organizer) about the change
     * @param string|null $comment      the user's comment with their answer to an invitation
     *
     * @return array<string, CalendarEvent> the resource's event rows by recurrence key
     */
    public function save(CalendarObject $object, VCalendar $calendar, bool $fromProvider = false, bool $notify = true, ?string $comment = null): array
    {
        $uids = array_keys(CalendarDocument::eventsByUid($calendar));
        if ([$object->getUid()] !== $uids) {
            throw new InvalidCalendarData(\sprintf('A calendar resource holds the events of exactly one UID, got: %s.', implode(', ', $uids) ?: 'none'));
        }
        foreach (CalendarDocument::events($calendar) as $event) {
            if (Occurrences::tooDense($event)) {
                throw new InvalidCalendarData('Events that repeat more often than every hour are not supported.');
            }
        }

        // The rows first: an event that cannot be read is refused before the resource itself changes.
        $rows = $this->projector->project($object, $calendar);
        $object->setIcal($calendar->serialize());
        if (!$this->entityManager->contains($object)) {
            $this->entityManager->persist($object);
        }
        $this->entityManager->flush();
        $this->planNotifications($object);

        if (!$fromProvider && !$object->getCalendar()->isLocal()) {
            $this->queuePut($object, $notify, $comment);
        }

        return $rows;
    }

    public function remove(CalendarObject $object, bool $fromProvider = false, bool $notify = true): void
    {
        $calendar = $object->getCalendar();
        $now = new \DateTimeImmutable();

        if (!$fromProvider && !$calendar->isLocal()) {
            $pending = $this->operations->findUnclaimedFor($object);
            $remoteId = $object->getRemoteId();
            if (null === $remoteId) {
                // Never reached the provider: only a pending write to drop. A write in progress reports back and
                // finds the resource gone; its result then turns into a delete (see completeWrite).
                if (null !== $pending) {
                    $this->entityManager->remove($pending);
                }
            } elseif (null !== $pending) {
                $pending->becomeDelete($remoteId, $object->getEtag());
                $pending->schedule($notify, null);
            } else {
                $this->entityManager->persist(CalendarOperation::delete($calendar, $object->getUid(), $remoteId, $object->getEtag(), $now, $notify));
            }
            $this->announce($calendar);
        }

        $this->planNotifications($object);
        $this->projector->remove($object);
        $this->entityManager->remove($object);
        $this->entityManager->flush();
    }

    /**
     * The object's reminders follow its change, once the change is committed, and so does the time the owner's todos
     * are planned at (once per commit, however many events it saves).
     */
    private function planNotifications(CalendarObject $object): void
    {
        $owner = $object->getCalendar()->getOwner()->getId()->toRfc4122();
        $this->afterCommit->dispatch(new PlanCalendarObject($object->getId()->toRfc4122(), $owner));
        $this->todoReplanning->afterCommit($owner);
    }

    /** Marks the rows of a resource with the reason its last change did not reach the provider (or clears it). */
    public function reportSyncError(CalendarObject $object, ?string $error): void
    {
        foreach ($this->entityManager->getRepository(CalendarEvent::class)->findBy(['object' => $object]) as $event) {
            $event->setSyncError($error);
        }
        $this->entityManager->flush();
    }

    /**
     * Sets the meeting link request of a resource (null clears it) on the resource and on its master row, without
     * writing anything to the provider.
     *
     * @param array{provider: string, status: string, reason: ?string, requestedAt: string, nonce: string}|null $request
     */
    public function setConferenceRequest(CalendarObject $object, ?array $request): void
    {
        $object->setConferenceRequest($request);
        $master = $this->entityManager->getRepository(CalendarEvent::class)->findOneBy(['object' => $object, 'recurrenceKey' => '']);
        $master?->setConferenceRequest(EventProjector::publicRequest($object));
        $this->entityManager->flush();
    }

    private function queuePut(CalendarObject $object, bool $notify, ?string $comment): void
    {
        $pending = $this->operations->findUnclaimedFor($object);
        if (null === $pending || CalendarOperationKind::Put !== $pending->getKind()) {
            $this->entityManager->persist(CalendarOperation::put($object, new \DateTimeImmutable(), $notify, $comment));
        } else {
            $pending->schedule($notify, $comment);
        }
        $this->entityManager->flush();
        $this->announce($object->getCalendar());
    }

    private function announce(Calendar $calendar): void
    {
        $account = $calendar->getMailAccount();
        if (null !== $account) {
            $this->notifier->outboxDue($account->getId());
        }
    }
}
