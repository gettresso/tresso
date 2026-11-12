<?php

declare(strict_types=1);

namespace App\Chat;

use App\ApiResource\ChatProblem;
use App\Entity\ChatAccount;
use App\Entity\User;
use App\Repository\ChatAccountRepository;
use Doctrine\DBAL\LockMode;
use Doctrine\ORM\EntityManagerInterface;
use Doctrine\ORM\EntityNotFoundException;
use Symfony\Component\HttpKernel\Exception\NotFoundHttpException;
use Symfony\Component\Uid\Uuid;

/**
 * The account a relay call is for, answered only for the desktop that relays it. Who may call at all (our desktop app
 * with `mail:write`) the operation's security decides through {@see \App\Security\ChatAccessVoter::MANAGE} and
 * {@see \App\Security\FirstPartyClients::DESKTOP_ATTRIBUTE}; this adds the two checks that need the account:
 *
 * - it belongs to the signed-in user (another user's id is not found);
 * - the call names its relaying device. Another desktop of the same user gets 409 `not_the_relay` until it takes over
 *   through `PUT /api/v1/chat-accounts/whatsapp`; the desktop that relayed before learns of it from this answer or
 *   from the account in the delta, and stops.
 *
 * Every answered call counts as a sign of life: the relay is online from then on, until the sweep finds it silent for
 * {@see SweepChatRelaysHandler::OFFLINE_AFTER}.
 */
final readonly class ChatRelayGuard
{
    public function __construct(
        private EntityManagerInterface $entityManager,
        private ChatAccountRepository $accounts,
        private ChatOwnerLock $ownerLock,
    ) {
    }

    /**
     * The account, locked until the transaction ends, so the calls of one relay take turns. Inside a transaction only.
     */
    public function relayedAccount(User $user, mixed $accountId, string $deviceId, \DateTimeImmutable $now): ChatAccount
    {
        [$account, $isRelay] = $this->account($user, $accountId, $deviceId, $now);
        if (!$isRelay) {
            throw ChatProblem::notTheRelay();
        }

        return $account;
    }

    /**
     * For a result only: the account, and whether the calling device relays it. A desktop that relayed before a
     * takeover may still report that a reply it claimed went out ({@see ChatQueue::report()}); it is no sign of life
     * of the relay.
     *
     * @return array{ChatAccount, bool}
     */
    public function reportingAccount(User $user, mixed $accountId, string $deviceId, \DateTimeImmutable $now): array
    {
        return $this->account($user, $accountId, $deviceId, $now);
    }

    /**
     * @return array{ChatAccount, bool}
     */
    private function account(User $user, mixed $accountId, string $deviceId, \DateTimeImmutable $now): array
    {
        $account = \is_string($accountId) ? $this->accounts->findOneOwnedBy($user, $accountId) : null;
        if (!$account instanceof ChatAccount) {
            throw new NotFoundHttpException('Chat account not found.');
        }
        $this->ownerLock->lock($user->getId());
        // Read again under the lock: a takeover or a removal that committed meanwhile is seen.
        try {
            $this->entityManager->refresh($account, LockMode::PESSIMISTIC_WRITE);
        } catch (EntityNotFoundException) {
            throw new NotFoundHttpException('Chat account not found.');
        }

        $isRelay = Uuid::isValid($deviceId) && $account->getRelayDeviceId()->equals(Uuid::fromString($deviceId));
        if ($isRelay) {
            $account->heardFromRelay($now);
        }

        return [$account, $isRelay];
    }
}
