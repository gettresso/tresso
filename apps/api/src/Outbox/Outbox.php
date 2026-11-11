<?php

declare(strict_types=1);

namespace App\Outbox;

use App\ApiResource\Input\Outbox\SendMessageInput;
use App\Entity\MailAccount;
use App\Entity\OutgoingMessage;
use App\Enum\OutgoingStatus;
use App\Enum\ScanStatus;
use App\Realtime\AfterCommitDispatcher;
use App\Realtime\RealtimeNotifier;
use App\Repository\DraftRepository;
use App\Repository\OutgoingMessageRepository;
use App\Scan\DownloadPolicy;
use App\Storage\BlobKind;
use App\Storage\BlobVault;
use Doctrine\ORM\EntityManagerInterface;
use Symfony\Component\Messenger\Stamp\DelayStamp;
use Symfony\Component\Uid\Uuid;

/**
 * The life of outgoing mail: queued by the user, released at its send time, claimed by the worker that leases the
 * account, then sent, retried later or failed. Every method runs inside the caller's transaction.
 */
final readonly class Outbox
{
    /** How long a worker may take before another worker may claim the message again. */
    public const string CLAIM_TTL = 'PT5M';
    public const int CLAIM_BATCH = 10;
    /** Waits before attempts 2, 3, ...: one minute up to three hours. */
    private const array RETRY_DELAYS = ['PT1M', 'PT5M', 'PT15M', 'PT1H', 'PT3H'];

    public function __construct(
        private EntityManagerInterface $entityManager,
        private MimeComposer $composer,
        private BlobVault $blobs,
        private RealtimeNotifier $notifier,
        private AfterCommitDispatcher $afterCommit,
        private OutgoingMessageRepository $messages,
        private DraftRepository $drafts,
        private DraftFiling $filing,
        private DownloadPolicy $downloads,
    ) {
    }

    /**
     * @param Uuid|null $id the id the client chose (a UUIDv7, see {@see SendMessageInput::$outgoingId}); a new one otherwise
     */
    public function queue(Composition $composition, \DateTimeImmutable $now, ?Uuid $id = null): OutgoingMessage
    {
        $composed = $this->composer->compose($composition);
        $stored = $this->blobs->store($composition->account->getOwner()->getId(), BlobKind::Outgoing, $composed->raw);

        $message = new OutgoingMessage(
            $composition->account,
            $composed->messageId,
            $composition->subject,
            ['to' => $composition->to, 'cc' => $composition->cc, 'bcc' => $composition->bcc],
            $stored->key,
            $stored->keyVersion,
            \strlen($composed->raw),
            $composition->sendAt,
            $composition->inReplyTo,
            $now,
            $id,
        );
        $this->entityManager->persist($message);
        $this->entityManager->flush();
        $this->announce($message);

        return $message;
    }

    public function cancel(OutgoingMessage $message): void
    {
        $message->cancel();
        $this->entityManager->flush();
        $this->settleDraft($message);
    }

    /** Called at the send time: a scheduled message whose time has come becomes due. */
    public function releaseIfDue(OutgoingMessage $message, \DateTimeImmutable $now): bool
    {
        if (OutgoingStatus::Scheduled !== $message->getStatus() || $message->getSendAt() > $now) {
            return false;
        }
        $message->makeDue();
        $this->entityManager->flush();
        $this->notifier->outboxDue($message->getMailAccount()->getId());

        return true;
    }

    /**
     * The safety net behind the delayed release messages: due scheduled messages of these accounts are released.
     *
     * @param list<string> $accountIds
     */
    public function releaseDue(array $accountIds, \DateTimeImmutable $now): void
    {
        foreach ($this->messages->lockDue($accountIds, $now, 100) as $message) {
            $this->releaseIfDue($message, $now);
        }
    }

    /**
     * @return list<OutgoingMessage>
     */
    public function claim(MailAccount $account, string $workerId, \DateTimeImmutable $now): array
    {
        $until = $now->add(new \DateInterval(self::CLAIM_TTL));
        $claimed = [];
        foreach ($this->messages->lockClaimable($account, $now, self::CLAIM_BATCH) as $message) {
            if (!$this->attachmentsMayGo($message)) {
                continue;
            }
            $message->claim($workerId, $until);
            $claimed[] = $message;
        }
        $this->entityManager->flush();

        return $claimed;
    }

    /**
     * The files were checked when the message was queued, but a rescan may have found malware since: such a message
     * fails, and its draft comes back. One that is somehow waiting for a scan stays queued until the scan is done.
     */
    private function attachmentsMayGo(OutgoingMessage $message): bool
    {
        $draft = $this->drafts->findSendingAs($message);
        foreach ($draft?->getAttachments() ?? [] as $attachment) {
            if (ScanStatus::Pending === $attachment->getScanStatus()) {
                return false;
            }
            // Files that could not be scanned were confirmed when the message was queued; a verdict never turns a file
            // into one later.
            $refusal = $this->downloads->sendingRefusal($attachment->getScanStatus(), $attachment->getFilename(), acceptUnscanned: true);
            if (null !== $refusal) {
                $this->reportFailed($message, $refusal);

                return false;
            }
        }

        return true;
    }

    public function reportSent(OutgoingMessage $message, \DateTimeImmutable $now, bool $copiedToSent): void
    {
        $message->markSent($now, $copiedToSent ? null : 'Sent, but its copy could not be saved in the Sent folder.');
        $this->entityManager->flush();
        $this->settleDraft($message);
    }

    public function reportFailed(OutgoingMessage $message, string $error): void
    {
        $message->markFailed($error);
        $this->entityManager->flush();
        $this->settleDraft($message);
    }

    /** A temporary failure (server busy, connection lost): try again later, or give up after too many attempts. */
    public function reportRetry(OutgoingMessage $message, string $error, \DateTimeImmutable $now): void
    {
        $delay = self::RETRY_DELAYS[min($message->getAttempts(), \count(self::RETRY_DELAYS)) - 1] ?? self::RETRY_DELAYS[0];
        $message->retryAt($now->add(new \DateInterval($delay)), $error);
        $this->entityManager->flush();
        $this->settleDraft($message);
        $this->announce($message);
    }

    /**
     * The draft a message was sent from follows what became of it: back as it was when the message was cancelled or
     * failed, gone once it went out. While it is on its way the draft stays out of sight.
     */
    private function settleDraft(OutgoingMessage $message): void
    {
        $draft = $this->drafts->findSendingAs($message);
        if (null === $draft) {
            return;
        }
        match ($message->getStatus()) {
            OutgoingStatus::Cancelled, OutgoingStatus::Failed => $this->filing->restore($draft),
            OutgoingStatus::Sent => $this->filing->discard($draft),
            default => null,
        };
    }

    private function announce(OutgoingMessage $message): void
    {
        match ($message->getStatus()) {
            OutgoingStatus::Queued => $this->notifier->outboxDue($message->getMailAccount()->getId()),
            OutgoingStatus::Scheduled => $this->afterCommit->dispatch(
                new ReleaseOutgoingMessage($message->getId()->toRfc4122()),
                [DelayStamp::delayUntil($message->getSendAt())],
            ),
            default => null,
        };
    }
}
