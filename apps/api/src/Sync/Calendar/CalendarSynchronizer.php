<?php

declare(strict_types=1);

namespace App\Sync\Calendar;

use App\ApiResource\Input\Sync\Calendar\CalendarListInput;
use App\ApiResource\Input\Sync\Calendar\InventoryInput;
use App\ApiResource\Input\Sync\Calendar\ObjectBatchInput;
use App\ApiResource\Input\Sync\Calendar\RemoteObjectInput;
use App\Calendar\CalendarStore;
use App\Calendar\EventNotes;
use App\Calendar\ICalendar\CalendarDocument;
use App\Calendar\ICalendar\InvalidCalendarData;
use App\Entity\Calendar;
use App\Entity\CalendarObject;
use App\Entity\CalendarOperation;
use App\Entity\MailAccount;
use App\Enum\CalendarSyncStatus;
use App\Repository\CalendarObjectRepository;
use App\Repository\CalendarOperationRepository;
use App\Repository\CalendarRepository;
use Doctrine\ORM\EntityManagerInterface;
use Psr\Log\LoggerInterface;
use Symfony\Component\DependencyInjection\Attribute\Autowire;

/**
 * What the worker reports about an account's provider calendars: the calendar list, the inventory of a calendar
 * (for servers without sync-token) and changed or removed resources. The provider's data wins, except for
 * resources with a local change still on its way to the provider: those are written first, and a conflict is
 * settled when the write reports back. Runs inside the caller's transaction.
 */
final readonly class CalendarSynchronizer
{
    public function __construct(
        private EntityManagerInterface $entityManager,
        private CalendarRepository $calendars,
        private CalendarObjectRepository $objects,
        private CalendarOperationRepository $operations,
        private CalendarStore $store,
        private EventNotes $notes,
        private LoggerInterface $logger,
        #[Autowire(env: 'bool:MAIL_ALLOW_UNSAFE_SERVERS')]
        private bool $allowUnsafe,
    ) {
    }

    /**
     * The address the worker found becomes the one it sends the password to next time: never over plain HTTP (outside
     * local test setups).
     *
     * @throws CalendarListRejected when the reported server address may not be stored
     */
    public function checkServer(CalendarListInput $input): void
    {
        if (null !== $input->serverUrl && 'https' !== strtolower((string) parse_url($input->serverUrl, \PHP_URL_SCHEME)) && !$this->allowUnsafe) {
            throw new CalendarListRejected('The calendar server address must use https.');
        }
    }

    /**
     * @throws CalendarListRejected when the reported server address may not be stored
     */
    public function syncCalendars(MailAccount $account, CalendarListInput $input): CalendarListResult
    {
        $this->checkServer($input);
        $previousHost = null === $account->getCalendarServer() ? null : parse_url($account->getCalendarServer(), \PHP_URL_HOST);
        $host = null === $input->serverUrl ? $previousHost : parse_url($input->serverUrl, \PHP_URL_HOST);
        if (null !== $input->serverUrl) {
            $account->setCalendarServer($input->serverUrl);
        }
        // An accepted list means the account's calendars can be reached, not that they sync: an error the worker
        // reported about the sync stays until a calendar completes a sync ({@see objects()}), or the status would flip
        // between error and active on every round while one calendar keeps failing.
        if (CalendarSyncStatus::Error !== $account->getCalendarStatus()) {
            $account->setCalendarStatus(CalendarSyncStatus::Active);
        }

        $existing = $this->calendars->findByAccount($account);
        $seen = [];
        $position = 0;
        foreach ($input->calendars as $remote) {
            if (isset($seen[$remote->remoteId])) {
                continue;
            }
            $calendar = $existing[$remote->remoteId] ?? null;
            if (null === $calendar) {
                $calendar = Calendar::remote($account, $input->source, $remote->remoteId, trim($remote->name), $remote->writable);
                $this->entityManager->persist($calendar);
            }
            $calendar->rename(trim($remote->name));
            $calendar->setColor($remote->color);
            $calendar->setTimeZone($remote->timeZone);
            $calendar->setWritable($remote->writable);
            $calendar->setProviderSchedules($input->providerSchedules);
            $calendar->setConferenceProviders(array_values(array_unique($remote->conferenceProviders)));
            $calendar->setPosition($position++);
            $seen[$remote->remoteId] = $calendar;
        }

        // Calendars missing from the list go, unless the list cannot be trusted to be complete: an empty list, or the
        // first list from another server (a flapping discovery must not wipe everything; the next list from the new
        // server removes them). A calendar with writes still to make stays until they are made.
        $trusted = [] !== $input->calendars && (null === $previousHost || $previousHost === $host);
        foreach ($existing as $remoteId => $calendar) {
            if (isset($seen[$remoteId])) {
                continue;
            }
            if (!$trusted || $this->operations->hasPendingFor($calendar)) {
                $this->logger->info('Keeping a calendar the provider did not list', ['calendar' => $calendar->getId()->toRfc4122(), 'trusted' => $trusted]);
                continue;
            }
            $this->entityManager->remove($calendar);
        }
        $this->chooseDefault($input, $seen);
        $this->entityManager->flush();

        return new CalendarListResult(array_values(array_map(
            static fn (Calendar $calendar): array => ['remoteId' => (string) $calendar->getRemoteId(), 'id' => $calendar->getId()->toRfc4122(), 'cursor' => $calendar->getSyncCursor()],
            $seen,
        )));
    }

    public function inventory(Calendar $calendar, InventoryInput $input): InventoryResult
    {
        $known = $this->objects->remoteVersions($calendar);
        $listed = [];
        $fetch = [];
        foreach ($input->objects as $object) {
            $listed[$object->remoteId] = true;
            if (!\array_key_exists($object->remoteId, $known) || null === $object->etag || $known[$object->remoteId] !== $object->etag) {
                $fetch[] = $object->remoteId;
            }
        }

        if ($input->partial) {
            return new InventoryResult($fetch, 0);
        }
        $gone = array_values(array_filter(array_keys($known), static fn (string $remoteId): bool => !isset($listed[$remoteId])));
        $removed = $this->removeRemote($calendar, $gone);

        return new InventoryResult($fetch, $removed);
    }

    public function objects(Calendar $calendar, ObjectBatchInput $input): ObjectBatchResult
    {
        $stored = $skipped = 0;
        $byRemoteId = $this->objects->findByRemoteIds($calendar, array_map(static fn (RemoteObjectInput $object): string => $object->remoteId, $input->changed));
        foreach ($input->changed as $remote) {
            if (null === $remote->ical || !$this->upsert($calendar, $byRemoteId[$remote->remoteId] ?? null, $remote)) {
                ++$skipped;
                continue;
            }
            ++$stored;
        }
        $removed = $this->removeRemote($calendar, array_values(array_unique($input->removed)));

        if (null !== $input->cursor) {
            $calendar->setSyncCursor($input->cursor);
            // The batch that carries the cursor ends a complete sync of this calendar: the sync works again.
            $account = $calendar->getMailAccount();
            if (null !== $account && CalendarSyncStatus::Error === $account->getCalendarStatus()) {
                $account->setCalendarStatus(CalendarSyncStatus::Active);
            }
        }
        $this->entityManager->flush();

        return new ObjectBatchResult($stored, $removed, $skipped);
    }

    /**
     * Stores the provider's version of a resource. Returns false when it was not taken (unreadable, or a local change
     * is waiting to be written).
     */
    public function upsert(Calendar $calendar, ?CalendarObject $object, RemoteObjectInput $remote): bool
    {
        try {
            $parsed = CalendarDocument::parse((string) $remote->ical);
            $groups = CalendarDocument::eventsByUid($parsed);
            if (1 !== \count($groups)) {
                // Not an event resource (a VTODO, an empty or a malformed one): nothing for the calendar.
                if (null !== $object) {
                    $this->store->remove($object, true);
                }

                return false;
            }
            $uid = (string) array_key_first($groups);
            $vcalendar = CalendarDocument::forUid($parsed, $uid);

            // The same resource under a new UID: the same event to the user, so it replaces the old object (once the
            // new version is stored) and the user's notes go along.
            $previous = null;
            if (null !== $object && $object->getUid() !== $uid) {
                $previous = $object;
                $object = null;
            }
            $object ??= $this->objects->findOneByUid($calendar, $uid);
            if (null !== $object && $this->hasPendingWrite($object)) {
                return false;
            }
            $object ??= new CalendarObject($calendar, $uid, '');
            $rows = $this->store->save($object, $vcalendar, true);
            $object->stored($remote->remoteId, $remote->etag);
            if (null !== $previous) {
                $notes = $this->notes->lift($previous, static fn (string $key): string => $key);
                $this->store->remove($previous, true);
                $this->notes->put($notes, $rows);
            }

            return true;
        } catch (InvalidCalendarData $e) {
            $this->logger->info('Skipping an unreadable calendar resource', ['calendar' => $calendar->getId()->toRfc4122(), 'remoteId' => $remote->remoteId, 'error' => $e->getMessage()]);

            return false;
        }
    }

    /**
     * @param list<string> $remoteIds
     */
    private function removeRemote(Calendar $calendar, array $remoteIds): int
    {
        $removed = 0;
        foreach (array_chunk($remoteIds, 500) as $chunk) {
            foreach ($this->objects->findByRemoteIds($calendar, $chunk) as $object) {
                if ($this->hasPendingWrite($object)) {
                    continue;
                }
                $this->store->remove($object, true);
                ++$removed;
            }
        }

        return $removed;
    }

    private function hasPendingWrite(CalendarObject $object): bool
    {
        return null !== $this->entityManager->getRepository(CalendarOperation::class)->findOneBy(['object' => $object]);
    }

    /**
     * @param array<string, Calendar> $calendars
     */
    private function chooseDefault(CalendarListInput $input, array $calendars): void
    {
        $current = array_filter($calendars, static fn (Calendar $calendar): bool => $calendar->isDefault() && $calendar->isWritable());
        if ([] !== $current) {
            return;
        }
        $hinted = null;
        foreach ($input->calendars as $remote) {
            if ($remote->isDefault && isset($calendars[$remote->remoteId]) && $calendars[$remote->remoteId]->isWritable()) {
                $hinted = $calendars[$remote->remoteId];
                break;
            }
        }
        $choice = $hinted ?? array_values(array_filter($calendars, static fn (Calendar $calendar): bool => $calendar->isWritable()))[0] ?? null;
        foreach ($calendars as $calendar) {
            $calendar->setDefault($calendar === $choice);
        }
    }
}
