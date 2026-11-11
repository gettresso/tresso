<?php

declare(strict_types=1);

namespace App\Notification;

use App\Controller\NotificationAddressConfirmationController;
use App\Deployment\PublicAddresses;
use App\Entity\NotificationPreferences;
use App\Entity\User;
use App\Enum\NotificationAddressProof;
use App\Notification\Channel\EmailNotifier;
use App\Realtime\AfterCommitDispatcher;
use App\Repository\NotificationPreferencesRepository;
use Doctrine\DBAL\Connection;
use Doctrine\ORM\EntityManagerInterface;
use Psr\Clock\ClockInterface;
use Symfony\Component\DependencyInjection\Attribute\Autowire;
use Symfony\Component\HttpFoundation\UriSigner;
use Symfony\Component\HttpKernel\Exception\TooManyRequestsHttpException;
use Symfony\Component\Mailer\Exception\TransportExceptionInterface;
use Symfony\Component\Mailer\MailerInterface;
use Symfony\Component\Messenger\Attribute\AsMessageHandler;
use Symfony\Component\Messenger\MessageBusInterface;
use Symfony\Component\Mime\Email;
use Symfony\Component\RateLimiter\RateLimiterFactoryInterface;
use Symfony\Component\Routing\Generator\UrlGeneratorInterface;
use Symfony\Component\Uid\Uuid;

/**
 * Where a user's notification mail goes, and the confirmation of an address Tresso cannot prove is theirs.
 *
 * When the user chooses an address, how it is theirs is recorded ({@see NotificationAddressProof}): their sign-in
 * address and a provider-confirmed account address ({@see NotificationAddresses}) count at once. Any other address
 * waits as pending: Tresso mails a signed link to it, valid for two days, and the address counts once someone opens
 * the link and confirms there. Until then notifications go where they went. Choosing the pending address again sends
 * the link again; choosing the current address again drops a pending one.
 *
 * A chosen address stops counting when its proof no longer holds (an account removed or renamed, a provider no longer
 * confirming it): notifications then go to the sign-in address, as they always did, and no mail goes to the address
 * the user gave up. Only an address that was never proven (chosen before proofs were recorded) is moved to pending
 * when a notification would first be mailed to it, with a link.
 *
 * Links go out after the transaction that made the address pending committed. One that could not go out (the day's
 * limit, a mail server error) is tried again with the next notification. At most {@see self::MAILS_PER_DAY} links a
 * day go out per user and {@see self::MAILS_PER_ADDRESS} per receiving address, whoever asks.
 */
#[AsMessageHandler]
final readonly class NotificationEmailAddress
{
    public const string LINK_LIFETIME = 'P2D';
    public const int MAILS_PER_DAY = 5;
    public const int MAILS_PER_ADDRESS = 3;

    public function __construct(
        private NotificationAddresses $provable,
        private NotificationPreferencesRepository $preferences,
        private EntityManagerInterface $entityManager,
        private Connection $connection,
        private AfterCommitDispatcher $afterCommit,
        private MessageBusInterface $bus,
        private MailerInterface $mailer,
        private EmailNotifier $email,
        private UriSigner $signer,
        private UrlGeneratorInterface $urls,
        private PublicAddresses $addresses,
        private ClockInterface $clock,
        #[Autowire(service: 'limiter.notification_address_confirmation')]
        private RateLimiterFactoryInterface $mailsPerUser,
        #[Autowire(service: 'limiter.notification_address_confirmation_target')]
        private RateLimiterFactoryInterface $mailsPerAddress,
    ) {
    }

    /** Where notification mail goes now: the chosen address while it counts, else the sign-in address. */
    public function effective(User $user, ?NotificationPreferences $preferences = null): string
    {
        $preferences ??= $this->preferences->forUser($user);
        $chosen = $preferences->getEmailAddress();

        return null !== $chosen && $this->counts($user, $preferences, $chosen) ? $chosen : $user->getEmail();
    }

    /**
     * Where a notification about to be mailed goes. A chosen address that was never proven gets the proof it has now
     * (a Microsoft account that synced since, say), or else is moved to pending here; a pending address whose link
     * did not go out yet is mailed its link.
     */
    public function forDelivery(User $user): string
    {
        $preferences = $this->preferences->forUser($user);
        $chosen = $preferences->getEmailAddress();
        if (null !== $chosen && null === $preferences->getEmailAddressProof()) {
            $proof = $this->provable->proofOf($user, $chosen);
            if (null !== $proof) {
                $preferences->proveEmailAddress($proof);
            } else {
                $preferences->moveEmailAddressToPending();
            }
            $this->entityManager->flush();
        }
        $pending = $preferences->getPendingEmailAddress();
        if (null !== $pending && null === $preferences->getPendingEmailSentAt() && $this->mayMail($user, $pending)) {
            $this->sendLinkAfterCommit($user, $pending);
        }

        return $this->effective($user, $preferences);
    }

    /**
     * The user chose where notification mail goes (null: the sign-in address).
     *
     * @throws TooManyRequestsHttpException when the address needs a link and too many went out today
     */
    public function choose(User $user, NotificationPreferences $preferences, ?string $address): void
    {
        if (null === $address) {
            $preferences->setEmailAddress(null);

            return;
        }
        $proof = $this->provable->proofOf($user, $address);
        if (null !== $proof) {
            $preferences->setEmailAddress($address, $proof);

            return;
        }
        if (mb_strtolower($address) === $preferences->getEmailAddress() && $this->counts($user, $preferences, $address)) {
            // Back to the address that already counts: a pending one the user changed their mind about goes.
            $preferences->setEmailAddress($address, $preferences->getEmailAddressProof(), $preferences->getEmailAddressConfirmedAt());

            return;
        }

        if (!$this->mayMail($user, $address)) {
            throw new TooManyRequestsHttpException(null, 'Too many confirmation mails today. Try again tomorrow.');
        }
        $preferences->choosePendingEmailAddress($address);
        $this->sendLinkAfterCommit($user, mb_strtolower($address));
    }

    /** Confirms the pending address the link was for; false when it is no longer the pending one. */
    public function confirm(string $userId, string $address): bool
    {
        $preferences = $this->preferencesOf($userId);
        $pending = $preferences?->getPendingEmailAddress();
        if (null === $preferences || null === $pending || $pending !== mb_strtolower($address)) {
            return false;
        }

        $preferences->setEmailAddress($pending, NotificationAddressProof::Link, $this->clock->now());
        $this->entityManager->flush();

        return true;
    }

    /** Whether the pending address of this user is the one a link names. */
    public function isPending(string $userId, string $address): bool
    {
        $pending = $this->preferencesOf($userId)?->getPendingEmailAddress();

        return null !== $pending && $pending === mb_strtolower($address);
    }

    /** Mails the link, once the change that made the address pending committed. */
    public function __invoke(MailNotificationAddressLink $message): void
    {
        $preferences = $this->preferencesOf($message->userId);
        if (null === $preferences || $preferences->getPendingEmailAddress() !== $message->address) {
            return;
        }
        $user = $preferences->getUser();

        $path = $this->urls->generate(NotificationAddressConfirmationController::ROUTE, ['user' => $message->userId, 'address' => $message->address]);
        // From the API's configured address, never from the host of the request that asked.
        $link = $this->signer->sign($this->addresses->api().$path, new \DateInterval(self::LINK_LIFETIME));
        $email = new Email()
            ->from($this->email->sender())
            ->to($message->address)
            ->subject('Confirm where Tresso sends your notifications')
            ->text(\sprintf("The Tresso account %s asked to send its notifications to this address.\n\nConfirm it here (the link works for two days):\n%s\n\nIf you did not ask for this, ignore this mail: nothing is sent here without your confirmation.", $user->getEmail(), $link))
            ->html(\sprintf('<p>The Tresso account %s asked to send its notifications to this address.</p><p><a href="%s">Confirm this address</a> (the link works for two days).</p><p>If you did not ask for this, ignore this mail: nothing is sent here without your confirmation.</p>', htmlspecialchars($user->getEmail()), htmlspecialchars($link)));
        $email->getHeaders()->addTextHeader('Auto-Submitted', 'auto-generated');

        try {
            $this->mailer->send($email);
        } catch (TransportExceptionInterface) {
            // Not marked as sent: the next notification tries again.
            return;
        }
        $preferences->markConfirmationSent($this->clock->now());
        $this->entityManager->flush();
    }

    private function sendLinkAfterCommit(User $user, string $address): void
    {
        $message = new MailNotificationAddressLink($user->getId()->toRfc4122(), $address);
        if ($this->connection->isTransactionActive()) {
            $this->afterCommit->dispatchOnce('notification-address-link:'.$message->userId, $message);
        } else {
            $this->bus->dispatch($message);
        }
    }

    /**
     * Takes one mail from both limits: per receiving address whoever asks, then per user. A refusal by the first
     * spends nothing of the user's.
     */
    private function mayMail(User $user, string $address): bool
    {
        return $this->mailsPerAddress->create(hash('sha256', mb_strtolower($address)))->consume()->isAccepted()
            && $this->mailsPerUser->create($user->getId()->toRfc4122())->consume()->isAccepted();
    }

    private function preferencesOf(string $userId): ?NotificationPreferences
    {
        $user = Uuid::isValid($userId) ? $this->entityManager->find(User::class, Uuid::fromString($userId)) : null;

        return null === $user ? null : $this->preferences->find($user);
    }

    private function counts(User $user, NotificationPreferences $preferences, string $address): bool
    {
        return NotificationAddressProof::Link === $preferences->getEmailAddressProof() || $this->provable->holds($user, $address);
    }
}
