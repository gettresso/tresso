<?php

declare(strict_types=1);

namespace App\Notification;

use App\Billing\Entitlements;
use App\Calendar\SelfAddresses;
use App\Entity\NotificationDelivery;
use App\Entity\NotificationDevice;
use App\Entity\User;
use App\Enum\DeviceKind;
use App\Enum\NotificationChannel;
use App\Notification\Channel\EmailNotifier;
use App\Notification\Channel\ExpoPushSender;
use App\Notification\Channel\PushMessage;
use App\Notification\Channel\PushResult;
use App\Notification\Channel\WebPushSender;
use App\Repository\NotificationDeviceRepository;
use App\Repository\NotificationPreferencesRepository;
use Doctrine\DBAL\ArrayParameterType;
use Doctrine\ORM\EntityManagerInterface;
use Psr\Log\LoggerInterface;
use Symfony\Component\Uid\Uuid;

/**
 * Sends one notification to every target of a user on the chosen channels: each enabled device whose channel is
 * chosen (Expo for the phone, web push and the desktop app for the desktop) and the notification email address.
 *
 * First every target is claimed with a delivery row for the delivery key, in the caller's transaction (so a
 * notification marked delivered always has its rows, and a crash before the sends leaves them to be retried) or in
 * one of its own. A target sent to before is skipped, so a retried message never notifies anyone twice; a target
 * whose send failed is claimed again after a pause that doubles with each attempt (up to MAX_ATTEMPTS), and one whose
 * send never reported back (a crash) after STUCK. A retry claims only the targets of the first delivery, not devices
 * registered since. Then the sends, outside any transaction, and their outcome. A device whose push service forgot
 * it is removed, at once or when Expo's receipt says so. The desktop app shows notifications from the delta, so its
 * delivery is complete once claimed.
 */
final readonly class NotificationDispatcher
{
    public const int MAX_ATTEMPTS = 5;
    /** A send that has not reported back after this is taken as lost. */
    public const string STUCK = '10 minutes';
    /** Expo has receipts some minutes after a send. */
    private const string RECEIPTS_AFTER = '-15 minutes';
    private const int RECEIPTS_BATCH = 300;

    public function __construct(
        private EntityManagerInterface $entityManager,
        private NotificationDeviceRepository $devices,
        private NotificationPreferencesRepository $preferences,
        private WebPushSender $webPush,
        private ExpoPushSender $expo,
        private EmailNotifier $email,
        private SelfAddresses $selfAddresses,
        private LoggerInterface $logger,
        private Entitlements $entitlements,
    ) {
    }

    /**
     * @return int how many targets were claimed now (0 when everything was sent before)
     */
    public function send(User $user, PushMessage $message, string $deliveryKey, NotificationChannelChoice $choice, \DateTimeImmutable $now): int
    {
        if ($choice->isEmpty()) {
            return 0;
        }
        /** @var list<array{string, ?NotificationDevice, ?string}> $claimed */
        $claimed = $this->entityManager->wrapInTransaction(fn (): array => $this->claim($user, $deliveryKey, $choice, true));

        return $this->deliver($claimed, $message, $deliveryKey, $now);
    }

    /**
     * Sends to the targets claim() returned, once its transaction committed.
     *
     * @param list<array{string, ?NotificationDevice, ?string}> $claimed
     *
     * @return int how many targets were sent to
     */
    public function deliver(array $claimed, PushMessage $message, string $deliveryKey, \DateTimeImmutable $now): int
    {
        foreach ($claimed as [$target, $device, $address]) {
            $pushed = null === $device ? $message : $message->forUser($device->getUser()->getId()->toRfc4122());
            $result = match (true) {
                null !== $address => $this->email->send($address, $message),
                DeviceKind::WebPush === $device?->getKind() => $this->webPush->send($device, $pushed, $now),
                DeviceKind::Expo === $device?->getKind() => $this->expo->send($device, $pushed, $now),
                default => PushResult::sent(),
            };
            $this->record($deliveryKey, $target, $device, $result);
        }

        return \count($claimed);
    }

    /**
     * Claims the targets to send to now, in the caller's transaction. With $newTargets false (a retry) only targets
     * that already have a delivery row are claimed again.
     *
     * @return list<array{string, ?NotificationDevice, ?string}> the targets claimed now, with the device or address
     */
    public function claim(User $user, string $deliveryKey, NotificationChannelChoice $choice, bool $newTargets): array
    {
        // A user whose trial or subscription ended gets nothing, on any channel, until they pay again.
        if ($choice->isEmpty() || !$this->entitlements->allows($user->getId())) {
            return [];
        }
        $targets = [];
        foreach ($this->devices->findEnabled($user) as $device) {
            if ($choice->includes(NotificationChannel::ofDevice($device->getKind()))) {
                $targets[] = [$device->getId()->toRfc4122(), $device, null];
            }
        }
        if ($choice->includes(NotificationChannel::Email)) {
            $targets[] = ['email', null, $this->emailAddressFor($user)];
        }

        $connection = $this->entityManager->getConnection();
        if (!$newTargets) {
            /** @var list<string> $again */
            $again = $connection->fetchFirstColumn(
                "UPDATE notification_delivery AS d SET status = :sending, error = NULL, attempts = d.attempts + 1, updated_at = :now
                 WHERE d.delivery_key = :key AND d.target IN (:targets)
                   AND ((d.status = :failed AND d.attempts < :max AND d.updated_at <= CAST(:now AS TIMESTAMP) - INTERVAL '1 minute' * POWER(2, d.attempts - 1))
                     OR (d.status = :sending AND d.updated_at <= CAST(:now AS TIMESTAMP) - CAST(:stuck AS INTERVAL)))
                 RETURNING d.target",
                [
                    'key' => $deliveryKey, 'targets' => array_column($targets, 0), 'sending' => NotificationDelivery::SENDING, 'failed' => NotificationDelivery::FAILED,
                    'max' => self::MAX_ATTEMPTS, 'stuck' => self::STUCK, 'now' => new \DateTimeImmutable()->format('Y-m-d H:i:s'),
                ],
                ['targets' => ArrayParameterType::STRING],
            );

            return array_values(array_filter($targets, static fn (array $target): bool => \in_array($target[0], $again, true)));
        }
        $claimed = [];
        foreach ($targets as [$target, $device, $address]) {
            // The unique key decides, also against a send of the same key running at the same time: a new target is
            // inserted, a failed or stuck one taken over, and anything else (sent, or another send busy) left alone.
            $claimedRow = $connection->fetchOne(
                "INSERT INTO notification_delivery AS d (id, user_id, delivery_key, target, status, attempts, created_at, updated_at)
                 VALUES (:id, :user, :key, :target, :sending, 1, :now, :now)
                 ON CONFLICT (delivery_key, target) DO UPDATE SET status = :sending, error = NULL, attempts = d.attempts + 1, updated_at = :now
                 WHERE (d.status = :failed AND d.attempts < :max AND d.updated_at <= CAST(:now AS TIMESTAMP) - INTERVAL '1 minute' * POWER(2, d.attempts - 1))
                    OR (d.status = :sending AND d.updated_at <= CAST(:now AS TIMESTAMP) - CAST(:stuck AS INTERVAL))
                 RETURNING d.id",
                [
                    'id' => Uuid::v7()->toRfc4122(), 'user' => $user->getId()->toRfc4122(), 'key' => $deliveryKey, 'target' => $target,
                    'sending' => NotificationDelivery::SENDING, 'failed' => NotificationDelivery::FAILED, 'max' => self::MAX_ATTEMPTS,
                    'stuck' => self::STUCK, 'now' => new \DateTimeImmutable()->format('Y-m-d H:i:s'),
                ],
            );
            if (false !== $claimedRow) {
                $claimed[] = [$target, $device, $address];
            }
        }

        return $claimed;
    }

    /**
     * Where the user's notification email goes: the chosen address only while it is still one of the user's own (a
     * mail account may be gone since), else the sign-in address.
     */
    public function emailAddressFor(User $user): string
    {
        $chosen = $this->preferences->forUser($user)->getEmailAddress();

        return null !== $chosen && \in_array($chosen, $this->selfAddresses->of($user), true) ? $chosen : $user->getEmail();
    }

    private function record(string $deliveryKey, string $target, ?NotificationDevice $device, PushResult $result): void
    {
        $this->entityManager->wrapInTransaction(function () use ($deliveryKey, $target, $device, $result): void {
            $connection = $this->entityManager->getConnection();
            $connection->update('notification_delivery', [
                'status' => $result->status,
                'error' => null === $result->error ? null : mb_substr($result->error, 0, 500),
                'ticket' => $result->ticket,
                'updated_at' => new \DateTimeImmutable()->format('Y-m-d H:i:s'),
            ], ['delivery_key' => $deliveryKey, 'target' => $target]);
            if (NotificationDelivery::GONE === $result->status && null !== $device) {
                // The push service forgot the device (Expo DeviceNotRegistered, web push 404 or 410); so do we.
                $connection->delete('notification_device', ['id' => $device->getId()->toRfc4122()]);
            }
        });
        if (NotificationDelivery::FAILED === $result->status) {
            $this->logger->warning('A notification could not be delivered', ['key' => $deliveryKey, 'target' => $target, 'error' => $result->error]);
        }
    }

    /**
     * Reads Expo's receipts for sends some minutes old and removes the phones Expo says are gone
     * (DeviceNotRegistered); a receipt Expo does not have yet is asked for again next time.
     */
    public function checkReceipts(\DateTimeImmutable $now): void
    {
        $connection = $this->entityManager->getConnection();
        /** @var list<array{ticket: string, target: string}> $rows */
        $rows = $connection->fetchAllAssociative(
            'SELECT ticket, target FROM notification_delivery WHERE ticket IS NOT NULL AND updated_at <= :before ORDER BY updated_at LIMIT :limit',
            ['before' => $now->modify(self::RECEIPTS_AFTER)->format('Y-m-d H:i:s'), 'limit' => self::RECEIPTS_BATCH],
        );
        $tickets = array_column($rows, 'ticket');
        $receipts = $this->expo->receipts($tickets);
        if (null === $receipts) {
            return;
        }
        $targets = array_column($rows, 'target', 'ticket');
        $this->entityManager->wrapInTransaction(function () use ($connection, $tickets, $receipts, $targets, $now): void {
            foreach ($receipts['gone'] as $ticket) {
                $connection->delete('notification_device', ['id' => $targets[$ticket]]);
            }
            // Expo keeps receipts for a day; older tickets will never have one.
            $connection->executeStatement('UPDATE notification_delivery SET ticket = NULL WHERE ticket IS NOT NULL AND updated_at <= :expired', ['expired' => $now->modify('-1 day')->format('Y-m-d H:i:s')]);
            $read = array_values(array_diff($tickets, $receipts['pending']));
            if ([] !== $read) {
                $connection->executeStatement('UPDATE notification_delivery SET ticket = NULL WHERE ticket IN (:tickets)', ['tickets' => $read], ['tickets' => ArrayParameterType::STRING]);
            }
        });
    }
}
