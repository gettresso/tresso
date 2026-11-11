<?php

declare(strict_types=1);

namespace App\Notification;

use App\Controller\NotificationAddressConfirmationController;
use App\Entity\NotificationPreferences;
use App\Entity\User;
use App\Notification\Channel\EmailNotifier;
use App\Repository\NotificationPreferencesRepository;
use Doctrine\ORM\EntityManagerInterface;
use Psr\Clock\ClockInterface;
use Symfony\Component\DependencyInjection\Attribute\Autowire;
use Symfony\Component\HttpFoundation\UriSigner;
use Symfony\Component\HttpKernel\Exception\TooManyRequestsHttpException;
use Symfony\Component\Mailer\Exception\TransportExceptionInterface;
use Symfony\Component\Mailer\MailerInterface;
use Symfony\Component\Mime\Email;
use Symfony\Component\RateLimiter\RateLimiterFactoryInterface;
use Symfony\Component\Routing\Generator\UrlGeneratorInterface;
use Symfony\Component\Uid\Uuid;

/**
 * Where a user's notification mail goes, and the confirmation of an address Tresso cannot prove is theirs.
 *
 * An address counts at once when the user provably holds it ({@see NotificationAddresses}: the sign-in address, a
 * provider-confirmed account). Any other address (an IMAP account's, any address at all) waits as pending: Tresso
 * mails a link to it, valid for two days, and the address counts once someone opens the link and confirms there. Until
 * then notifications go where they went before. Choosing the pending address again sends the link again. At most
 * {@see self::MAILS_PER_DAY} such mails go out per user a day (the `notification_address_confirmation` limiter).
 *
 * An address chosen before confirmation existed and not provable is moved to pending the first time a notification
 * would go to it, and one link is mailed then; until it is confirmed, notifications go to the sign-in address.
 */
final readonly class NotificationEmailAddress
{
    public const string LINK_LIFETIME = 'P2D';
    public const int MAILS_PER_DAY = 5;

    public function __construct(
        private NotificationAddresses $provable,
        private NotificationPreferencesRepository $preferences,
        private EntityManagerInterface $entityManager,
        private MailerInterface $mailer,
        private EmailNotifier $email,
        private UriSigner $signer,
        private UrlGeneratorInterface $urls,
        private ClockInterface $clock,
        #[Autowire(service: 'limiter.notification_address_confirmation')]
        private RateLimiterFactoryInterface $mails,
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
     * Where a notification about to be mailed goes. A chosen address from before confirmation existed that does not
     * count is moved to pending here, with one confirmation link.
     */
    public function forDelivery(User $user): string
    {
        $preferences = $this->preferences->forUser($user);
        $chosen = $preferences->getEmailAddress();
        if (null !== $chosen && !$this->counts($user, $preferences, $chosen)) {
            $preferences->moveEmailAddressToPending();
            $this->mailLink($user, $preferences);
            $this->entityManager->flush();
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
        if (null === $address || $this->provable->holds($user, $address)) {
            $preferences->setEmailAddress($address);

            return;
        }
        if ($address === $preferences->getEmailAddress() && $this->counts($user, $preferences, $address)) {
            return;
        }

        $preferences->choosePendingEmailAddress($address);
        if (!$this->mailLink($user, $preferences)) {
            throw new TooManyRequestsHttpException(null, 'Too many confirmation mails today. Try again tomorrow.');
        }
    }

    /** Confirms the pending address the link was for; false when it is no longer the pending one. */
    public function confirm(string $userId, string $address): bool
    {
        $preferences = $this->preferencesOf($userId);
        if (null === $preferences || null === $preferences->getPendingEmailAddress() || $preferences->getPendingEmailAddress() !== mb_strtolower($address)) {
            return false;
        }

        $preferences->setEmailAddress($preferences->getPendingEmailAddress(), $this->clock->now());
        $this->entityManager->flush();

        return true;
    }

    /** Whether the pending address of this user is the one a link names. */
    public function isPending(string $userId, string $address): bool
    {
        $preferences = $this->preferencesOf($userId);

        return null !== $preferences && null !== $preferences->getPendingEmailAddress() && $preferences->getPendingEmailAddress() === mb_strtolower($address);
    }

    private function preferencesOf(string $userId): ?NotificationPreferences
    {
        $user = Uuid::isValid($userId) ? $this->entityManager->find(User::class, Uuid::fromString($userId)) : null;

        return null === $user ? null : $this->preferences->find($user);
    }

    private function counts(User $user, NotificationPreferences $preferences, string $address): bool
    {
        return null !== $preferences->getEmailAddressConfirmedAt() || $this->provable->holds($user, $address);
    }

    /** Mails the link for the pending address; false when the day's limit was reached. A failed send is left to a retry. */
    private function mailLink(User $user, NotificationPreferences $preferences): bool
    {
        $address = $preferences->getPendingEmailAddress();
        if (null === $address) {
            return true;
        }
        if (!$this->mails->create($user->getId()->toRfc4122())->consume()->isAccepted()) {
            return false;
        }

        $link = $this->signer->sign(
            $this->urls->generate(NotificationAddressConfirmationController::ROUTE, ['user' => $user->getId()->toRfc4122(), 'address' => $address], UrlGeneratorInterface::ABSOLUTE_URL),
            new \DateInterval(self::LINK_LIFETIME),
        );
        $email = new Email()
            ->from($this->email->sender())
            ->to($address)
            ->subject('Confirm where Tresso sends your notifications')
            ->text(\sprintf("The Tresso account %s asked to send its notifications to this address.\n\nConfirm it here (the link works for two days):\n%s\n\nIf you did not ask for this, ignore this mail: nothing is sent here without your confirmation.", $user->getEmail(), $link))
            ->html(\sprintf('<p>The Tresso account %s asked to send its notifications to this address.</p><p><a href="%s">Confirm this address</a> (the link works for two days).</p><p>If you did not ask for this, ignore this mail: nothing is sent here without your confirmation.</p>', htmlspecialchars($user->getEmail()), htmlspecialchars($link)));
        $email->getHeaders()->addTextHeader('Auto-Submitted', 'auto-generated');

        try {
            $this->mailer->send($email);
        } catch (TransportExceptionInterface) {
            return true;
        }
        $preferences->markConfirmationSent($this->clock->now());

        return true;
    }
}
