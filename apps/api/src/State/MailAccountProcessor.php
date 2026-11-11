<?php

declare(strict_types=1);

namespace App\State;

use ApiPlatform\Metadata\DeleteOperationInterface;
use ApiPlatform\Metadata\Operation;
use ApiPlatform\State\ProcessorInterface;
use ApiPlatform\Validator\Exception\ValidationException;
use App\ApiResource\Input\CreateMailAccount;
use App\ApiResource\Input\UpdateMailAccount;
use App\ApiResource\MailAccountResource;
use App\Entity\Draft;
use App\Entity\MailAccount;
use App\Entity\User;
use App\Enum\MailAccountStatus;
use App\Enum\MailProvider;
use App\Enum\OAuthProvider;
use App\ProviderAuth\ProviderAccessTokens;
use App\ProviderAuth\ProviderClient;
use App\Realtime\RealtimeNotifier;
use App\Repository\MailAccountRepository;
use App\Repository\ProviderGrantRepository;
use App\Repository\TodoRepository;
use App\Security\CurrentUser;
use App\Security\FirstPartyClients;
use App\Security\Crypto\CredentialVault;
use Doctrine\ORM\EntityManagerInterface;
use Symfony\Bundle\SecurityBundle\Security;
use Symfony\Component\HttpKernel\Exception\AccessDeniedHttpException;
use Symfony\Component\HttpKernel\Exception\NotFoundHttpException;
use Symfony\Component\Validator\ConstraintViolation;
use Symfony\Component\Validator\ConstraintViolationList;

/**
 * Creates, updates and deletes the signed-in user's mail accounts. Passwords go straight into the credential vault.
 * Gmail and Microsoft 365 accounts are created through {@see \App\ProviderAuth\ProviderConnector}; here they can be
 * renamed, paused and removed, and removing the last account of a provider grant also ends the grant. Adding and
 * removing accounts, and changing how one connects, is for our own apps only (see the resource and
 * {@see self::assertConnectionChangeAllowed()}).
 *
 * @implements ProcessorInterface<CreateMailAccount|UpdateMailAccount|MailAccountResource, MailAccountResource|null>
 */
final readonly class MailAccountProcessor implements ProcessorInterface
{
    public function __construct(
        private MailAccountRepository $accounts,
        private CurrentUser $currentUser,
        private CredentialVault $vault,
        private EntityManagerInterface $entityManager,
        private ProviderAccessTokens $providerTokens,
        private ProviderClient $providerClient,
        private ProviderGrantRepository $grants,
        private TodoRepository $todos,
        private Security $security,
        private RealtimeNotifier $notifier,
    ) {
    }

    public function process(mixed $data, Operation $operation, array $uriVariables = [], array $context = []): ?MailAccountResource
    {
        // Checked before the transaction: an exception inside it would close the entity manager.
        if ($data instanceof UpdateMailAccount) {
            $account = $this->ownedAccount($this->currentUser->get(), $uriVariables);
            $this->assertConnectionChangeAllowed($data);
            if (!$account->usesServers()) {
                $this->assertNoServerChanges($account, $data);
            } else {
                $this->assertPasswordForNewServer($account, $data);
            }
        }

        /** @var list<array{OAuthProvider, string}> $endedGrants provider and refresh token of grants deleted with their last account */
        $endedGrants = [];
        // One transaction per write, so change numbers for client sync commit in order.
        $result = $this->entityManager->wrapInTransaction(function () use ($data, $operation, $uriVariables, &$endedGrants): ?MailAccountResource {
            return $this->write($data, $operation, $uriVariables, $endedGrants);
        });

        // Only once the deletion is committed: the provider call cannot be rolled back.
        foreach ($endedGrants as [$provider, $refreshToken]) {
            $this->providerClient->revoke($provider, $refreshToken);
        }

        return $result;
    }

    /**
     * @param array<string, mixed> $uriVariables
     * @param list<array{OAuthProvider, string}> $endedGrants
     */
    private function write(mixed $data, Operation $operation, array $uriVariables, array &$endedGrants): ?MailAccountResource
    {
        $owner = $this->currentUser->get();

        if ($data instanceof CreateMailAccount) {
            return $this->create($owner, $data);
        }

        $account = $this->ownedAccount($owner, $uriVariables);

        if ($operation instanceof DeleteOperationInterface) {
            $grant = $account->getProviderGrant();
            // Drafts outlive the account; detached here rather than by the foreign key, so every device hears of it.
            foreach ($this->entityManager->getRepository(Draft::class)->findBy(['mailAccount' => $account]) as $draft) {
                $draft->detachFromAccount();
                // Its message goes with the account, unsent: the draft comes back to be sent from another one.
                if ($draft->isSending()) {
                    $draft->restoreFromSending();
                }
            }
            // Todos outlive the account too; their link to its mail goes here, so every device drops it.
            foreach ($this->todos->findByMailAccount($account) as $todo) {
                $todo->detachFromMessage();
            }
            $this->entityManager->remove($account);
            $this->entityManager->flush();

            if (null !== $grant && [] === $this->accounts->findByProviderGrant($grant)) {
                $refreshToken = $this->providerTokens->refreshToken($grant);
                $this->entityManager->remove($grant);
                $this->entityManager->flush();
                // Revoking at the provider ends the app's access to that provider account for every Tresso user who
                // connected it; only our own tokens go while someone else still uses it.
                if (null !== $refreshToken && !$this->grants->existsForSubject($grant->getProvider(), $grant->getSubject())) {
                    $endedGrants[] = [$grant->getProvider(), $refreshToken];
                }
            }

            return null;
        }

        if (!$data instanceof UpdateMailAccount) {
            throw new \LogicException(\sprintf('Unexpected input %s for %s.', get_debug_type($data), $operation->getName()));
        }

        return $this->update($account, $data);
    }

    private function create(User $owner, CreateMailAccount $input): MailAccountResource
    {
        if ($this->accounts->existsForOwner($owner, $input->emailAddress)) {
            throw new ValidationException(new ConstraintViolationList([
                new ConstraintViolation('You already connected this email address.', null, [], $input, 'emailAddress', $input->emailAddress),
            ]));
        }

        $imap = $input->imap ?? throw new \LogicException('Validation guarantees IMAP settings.');
        $smtp = $input->smtp ?? throw new \LogicException('Validation guarantees SMTP settings.');

        $account = new MailAccount($owner, $input->emailAddress, $input->displayName, MailProvider::Imap);
        $account->configureServers($imap, $smtp, $input->username);
        $account->setCalendarServer($input->calendarUrl);
        $this->vault->seal($account, ['type' => 'password', 'password' => $input->password]);

        $this->entityManager->persist($account);
        $this->entityManager->flush();

        return MailAccountResource::fromEntity($account);
    }

    private function update(MailAccount $account, UpdateMailAccount $input): MailAccountResource
    {
        if (null !== $input->displayName) {
            $account->setDisplayName($input->displayName);
        }

        if (null !== $input->imap || null !== $input->smtp || null !== $input->username) {
            $account->configureServers(
                $input->imap ?? $account->getImap() ?? throw new \LogicException('IMAP accounts have IMAP settings.'),
                $input->smtp ?? $account->getSmtp() ?? throw new \LogicException('IMAP accounts have SMTP settings.'),
                $input->username ?? $account->getUsername() ?? throw new \LogicException('IMAP accounts have a username.'),
            );
        }

        if (null !== $input->calendarUrl) {
            $account->setCalendarServer('' === $input->calendarUrl ? null : $input->calendarUrl);
        }

        if (null !== $input->password) {
            $this->vault->seal($account, ['type' => 'password', 'password' => $input->password]);
        }

        // New credentials or servers deserve a fresh try: the old failure no longer says anything about them, and the
        // worker holding the account tries again now instead of after its backoff.
        $changesConnection = null !== $input->password || null !== $input->imap || null !== $input->smtp || null !== $input->username;
        if ($changesConnection && \in_array($account->getStatus(), [MailAccountStatus::AuthFailed, MailAccountStatus::Error], true)) {
            $account->setStatus(MailAccountStatus::Active);
            $this->notifier->outboxDue($account->getId());
        }

        if (null !== $input->status) {
            $account->setStatus($input->status);
        }

        $this->entityManager->flush();

        return MailAccountResource::fromEntity($account);
    }

    /**
     * How an account connects (servers, username, password, calendar server) changes only in our own apps: an app that
     * is not ours, or a personal access token, could otherwise point the account at its own server and have Tresso log
     * in there. Name, status and other plain settings stay open to every client with settings:write.
     */
    private function assertConnectionChangeAllowed(UpdateMailAccount $input): void
    {
        $changesConnection = null !== $input->username || null !== $input->password || null !== $input->imap
            || null !== $input->smtp || null !== $input->calendarUrl;
        if ($changesConnection && !FirstPartyClients::signedRequest($this->security->getToken())) {
            throw new AccessDeniedHttpException('Only Tresso\'s own apps can change how a mail account connects.');
        }
    }

    /**
     * The stored password is never sent to a server other than the one it was given for: a new IMAP or SMTP host, a new
     * username or a calendar server on a new host needs the password again.
     */
    private function assertPasswordForNewServer(MailAccount $account, UpdateMailAccount $input): void
    {
        if (null !== $input->password) {
            return;
        }
        $changed = [];
        if (null !== $input->imap && !self::sameHost($input->imap->host, $account->getImap()?->host)) {
            $changed[] = 'IMAP server';
        }
        if (null !== $input->smtp && !self::sameHost($input->smtp->host, $account->getSmtp()?->host)) {
            $changed[] = 'SMTP server';
        }
        if (null !== $input->username && $input->username !== $account->getUsername()) {
            $changed[] = 'username';
        }
        if (null !== $input->calendarUrl && '' !== $input->calendarUrl) {
            $current = $account->getCalendarServer();
            if (!self::sameHost((string) parse_url($input->calendarUrl, \PHP_URL_HOST), null === $current ? null : (string) parse_url($current, \PHP_URL_HOST))) {
                $changed[] = 'calendar server';
            }
        }
        if ([] === $changed) {
            return;
        }

        throw new ValidationException(new ConstraintViolationList([new ConstraintViolation(
            \sprintf('Enter the password again for the new %s: Tresso never sends the saved password to another server or user.', implode(' and ', $changed)),
            null,
            [],
            $input,
            'password',
            null,
        )]));
    }

    private static function sameHost(string $new, ?string $current): bool
    {
        return null !== $current && strtolower(rtrim($new, '.')) === strtolower(rtrim($current, '.'));
    }

    /**
     * Accounts that sign in through a provider have no password or servers to change; signing in again fixes them.
     */
    private function assertNoServerChanges(MailAccount $account, UpdateMailAccount $input): void
    {
        $violations = new ConstraintViolationList();
        foreach (['username' => $input->username, 'password' => $input->password, 'imap' => $input->imap, 'smtp' => $input->smtp] as $field => $value) {
            if (null !== $value) {
                $violations->add(new ConstraintViolation(
                    \sprintf('This account signs in with %s; it has no %s to change.', OAuthProvider::forMailProvider($account->getProvider())?->label() ?? 'its provider', 'password' === $field ? 'password' : 'server settings'),
                    null,
                    [],
                    $input,
                    $field,
                    null,
                ));
            }
        }
        if (\count($violations) > 0) {
            throw new ValidationException($violations);
        }
    }

    /**
     * @param array<string, mixed> $uriVariables
     */
    private function ownedAccount(User $owner, array $uriVariables): MailAccount
    {
        $id = $uriVariables['id'] ?? null;

        return (\is_string($id) ? $this->accounts->findOneOwnedBy($owner, $id) : null)
            ?? throw new NotFoundHttpException('Mail account not found.');
    }
}
