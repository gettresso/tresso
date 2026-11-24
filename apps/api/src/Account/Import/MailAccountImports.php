<?php

declare(strict_types=1);

namespace App\Account\Import;

use App\Entity\MailAccount;
use App\Entity\MailAccountImport;
use App\Entity\User;
use App\Enum\ImportEntryState;
use App\Enum\ImportFailure;
use App\Enum\ImportProviderHint;
use App\ProviderAuth\ConnectError;
use App\Repository\MailAccountImportRepository;
use App\Repository\MailAccountRepository;
use App\Security\CallerKey;
use App\Security\Crypto\FieldVault;
use Doctrine\DBAL\LockMode;
use Doctrine\ORM\EntityManagerInterface;
use Psr\Clock\ClockInterface;
use Symfony\Component\Uid\Uuid;

/**
 * Mail account import lists: a short list of addresses the user wants to add, which the user then connects one by one
 * on the web app's page for it. Making a list connects nothing and asks for no password; every address is connected by
 * the user, through the same sign-in or server form as a single account.
 *
 * The entries are sealed with the owner's field key, bound to the list's row ({@see self::context()}). Whether the
 * owner has an entry's account is read whenever the list is read, never stored. Addresses never go to a log.
 *
 * Every list remembers its caller ({@see CallerKey}): an app or a token sees, follows and deletes only the lists it
 * made; Tresso's own apps see every list of the user.
 */
final readonly class MailAccountImports
{
    /** How many lists one user may have at a time; each lives a day, so this only stops a runaway app. */
    public const int MAX_LIVE_LISTS = 20;

    private const string FIELD = 'mail-account-import-entries';

    public function __construct(
        private EntityManagerInterface $entityManager,
        private MailAccountImportRepository $imports,
        private MailAccountRepository $mailAccounts,
        private FieldVault $vault,
        private ClockInterface $clock,
    ) {
    }

    /** The context the entries of list $id are sealed for. */
    public static function context(Uuid $id): string
    {
        return 'tresso:'.self::FIELD.':'.$id->toRfc4122();
    }

    /**
     * Sorts what was asked for into entries to take and addresses left out (not an address for this kind of list, given
     * twice, connected already), each with the reason. Nothing is stored.
     *
     * @param list<array{address: string, provider: ?ImportProviderHint}> $asked
     * @param bool                                                        $firstParty made in Tresso's own apps
     *                                                                                {@see ImportAddress::normalize()}
     *
     * @return array{taken: list<ImportEntry>, leftOut: list<array{index: int, address: string, reason: string, message: string}>}
     */
    public function sort(User $owner, array $asked, bool $firstParty): array
    {
        $connected = $this->connectedAddresses($owner);
        $taken = [];
        $seen = [];
        $leftOut = [];
        foreach ($asked as $index => $entry) {
            $address = ImportAddress::normalize($entry['address'], $firstParty);
            if (null === $address) {
                $leftOut[] = ['index' => $index, 'address' => mb_substr(trim($entry['address']), 0, 320), 'reason' => 'invalid', 'message' => 'This is not an email address.'];
                continue;
            }
            if (isset($seen[$address])) {
                $leftOut[] = ['index' => $index, 'address' => $address, 'reason' => 'duplicate', 'message' => 'This address is in the list already.'];
                continue;
            }
            $seen[$address] = true;
            if (isset($connected[$address])) {
                $leftOut[] = ['index' => $index, 'address' => $address, 'reason' => 'already_connected', 'message' => 'This address is connected already.'];
                continue;
            }
            $taken[] = new ImportEntry(Uuid::v4()->toRfc4122(), $address, $entry['provider']);
        }

        return ['taken' => $taken, 'leftOut' => $leftOut];
    }

    /**
     * Stores a list of the entries {@see self::sort()} took.
     *
     * Stores a list of the entries {@see self::sort()} took; null when the owner has {@see self::MAX_LIVE_LISTS}
     * already. The owner's row is locked while counting, so two lists made at once cannot both pass the count.
     *
     * @param non-empty-list<ImportEntry> $entries
     * @param string|null                 $createdBy the app that made it, when it is not one of Tresso's own
     * @param string                      $caller    {@see CallerKey} of the request
     */
    public function create(User $owner, array $entries, ?string $createdBy, string $caller): ?MailAccountImport
    {
        return $this->entityManager->wrapInTransaction(function () use ($owner, $entries, $createdBy, $caller): ?MailAccountImport {
            $this->entityManager->getConnection()->executeQuery('SELECT id FROM app_user WHERE id = :id FOR UPDATE', ['id' => $owner->getId()->toRfc4122()]);
            $now = $this->clock->now();
            if ($this->imports->countLiveOwnedBy($owner, $now) >= self::MAX_LIVE_LISTS) {
                return null;
            }
            $import = new MailAccountImport($owner, $createdBy, CallerKey::OURS === $caller ? null : $caller, $now);
            $this->seal($import, $entries);
            $this->entityManager->persist($import);
            $this->entityManager->flush();

            return $import;
        });
    }

    /**
     * The owner's list while it lives, for this caller: an app or a token gets only a list it made. Null for another
     * user's list, another app's, an unknown id, or one that expired.
     */
    public function find(User $owner, string $id, string $caller = CallerKey::OURS): ?MailAccountImport
    {
        $import = $this->imports->findLiveOwnedBy($owner, $id, $this->clock->now());

        return null === $import || !self::visibleTo($import, $caller) ? null : $import;
    }

    /**
     * The owner's lists that live and this caller may see, newest first.
     *
     * @return list<MailAccountImport>
     */
    public function liveOf(User $owner, string $caller = CallerKey::OURS): array
    {
        return array_values(array_filter($this->imports->findAllLiveOwnedBy($owner, $this->clock->now()), static fn (MailAccountImport $import): bool => self::visibleTo($import, $caller)));
    }

    /** Marks a list an app made as checked by the user: from now on the page looks the addresses up and signs in. */
    public function confirm(MailAccountImport $import): void
    {
        $import->confirm($this->clock->now());
        $this->entityManager->flush();
    }

    private static function visibleTo(MailAccountImport $import, string $caller): bool
    {
        return CallerKey::OURS === $caller || $import->getCreatedByCaller() === $caller;
    }

    /**
     * @return list<ImportEntry>
     */
    public function entries(MailAccountImport $import): array
    {
        $json = $this->vault->open($import->getOwner()->getId(), self::context($import->getId()), $import->getSealedEntries());
        $data = json_decode($json, true, flags: \JSON_THROW_ON_ERROR);
        if (!\is_array($data) || !array_is_list($data)) {
            throw new \UnexpectedValueException('The entries of a mail account import list are not a list.');
        }

        return array_map(static fn (mixed $entry): ImportEntry => ImportEntry::fromArray(\is_array($entry) ? $entry : []), $data);
    }

    /**
     * Each entry with where it stands, connected ones with their mail account.
     *
     * @return list<array{entry: ImportEntry, state: ImportEntryState, account: ?MailAccount}>
     */
    public function view(MailAccountImport $import): array
    {
        $accounts = [];
        foreach ($this->mailAccounts->findOwnedBy($import->getOwner()) as $account) {
            $accounts[self::spelling($account->getEmailAddress())] = $account;
        }

        return array_map(static function (ImportEntry $entry) use ($accounts): array {
            $account = $accounts[$entry->address] ?? null;
            $state = match (true) {
                null !== $account && $entry->added => ImportEntryState::Connected,
                null !== $account => ImportEntryState::AlreadyConnected,
                $entry->skipped => ImportEntryState::Skipped,
                // "Connected another way" said only while that account existed: once it is gone the row is to do.
                ImportFailure::AlreadyConnected === $entry->failure => ImportEntryState::Todo,
                null !== $entry->failure => ImportEntryState::Failed,
                default => ImportEntryState::Todo,
            };

            return ['entry' => $entry, 'state' => $state, 'account' => $account];
        }, $this->entries($import));
    }

    /**
     * Sets an entry to skipped, back to do (clearing a failure), failed with a reason, or connected: added from this
     * list, which the server form of the page says once it created the account. False when the list has no such entry,
     * or for connected when the owner has no account with its address.
     */
    public function mark(MailAccountImport $import, string $entryId, ImportEntryState $state, ?ImportFailure $failure): bool
    {
        if (ImportEntryState::AlreadyConnected === $state) {
            throw new \InvalidArgumentException('Already connected is read from the mail accounts, never set.');
        }
        if (ImportEntryState::Connected === $state) {
            $connected = $this->connectedAddresses($import->getOwner());

            return $this->change($import->getId(), static fn (ImportEntry $entry): bool => $entry->id === $entryId && isset($connected[$entry->address]), static fn (ImportEntry $entry): ImportEntry => $entry->asAdded());
        }

        return $this->change($import->getId(), static fn (ImportEntry $entry): bool => $entry->id === $entryId, static fn (ImportEntry $entry): ImportEntry => match ($state) {
            ImportEntryState::Skipped => $entry->with(true, null),
            ImportEntryState::Failed => $entry->with(false, $failure ?? ImportFailure::Failed),
            default => $entry->with(false, null),
        });
    }

    /**
     * A sign-in started from the list for $address ended: with $error its entry says why, without (connected) an
     * earlier failure is cleared. Nothing happens when the list is gone (expired, deleted) or no longer holds the
     * address.
     */
    public function settleSignIn(User $owner, string $importId, string $address, ?ConnectError $error): void
    {
        $import = $this->find($owner, $importId);
        if (null === $import) {
            return;
        }
        $address = self::spelling($address);
        $this->change(
            $import->getId(),
            static fn (ImportEntry $entry): bool => $entry->address === $address,
            static fn (ImportEntry $entry): ImportEntry => null === $error ? $entry->asAdded() : $entry->with(false, ImportFailure::fromConnectError($error)),
        );
    }

    /**
     * Whether the owner's live list $importId holds $address and may be used: a list an app made only once the user
     * confirmed it. Nothing is looked up or signed in for its addresses before.
     */
    public function holds(User $owner, string $importId, string $address): bool
    {
        $import = $this->find($owner, $importId);
        if (null === $import || !$import->isConfirmed()) {
            return false;
        }
        $address = ImportAddress::normalize($address, true);

        return null !== $address && [] !== array_filter($this->entries($import), static fn (ImportEntry $entry): bool => $entry->address === $address);
    }

    public function delete(MailAccountImport $import): void
    {
        $this->entityManager->remove($import);
        $this->entityManager->flush();
    }

    /**
     * Deletes the lists that expired. Returns how many went.
     */
    public function sweep(): int
    {
        return (int) $this->entityManager->getConnection()->executeStatement(
            'DELETE FROM mail_account_import WHERE expires_at <= :now',
            ['now' => $this->clock->now()->format('Y-m-d H:i:s')],
        );
    }

    /**
     * Reseals the entries of list $id with the owner's current key, after a key rotation ({@see \App\Storage\Reencryption}).
     */
    public function reseal(Uuid $owner, Uuid $id, string $sealed): string
    {
        return $this->vault->seal($owner, self::context($id), $this->vault->open($owner, self::context($id), $sealed));
    }

    /**
     * Changes the first entry $matches finds, in one transaction holding the list's row, so two changes at once (the
     * page skipping one entry while a sign-in for another fails) both stay. False when no entry matched.
     *
     * @param \Closure(ImportEntry): bool        $matches
     * @param \Closure(ImportEntry): ImportEntry $change
     */
    private function change(Uuid $id, \Closure $matches, \Closure $change): bool
    {
        return $this->entityManager->wrapInTransaction(function () use ($id, $matches, $change): bool {
            $import = $this->entityManager->find(MailAccountImport::class, $id);
            if (!$import instanceof MailAccountImport) {
                return false;
            }
            // Locked, and read as it is now rather than as an earlier read of this request left it.
            $this->entityManager->refresh($import, LockMode::PESSIMISTIC_WRITE);
            $entries = $this->entries($import);
            $found = false;
            foreach ($entries as $index => $entry) {
                if ($matches($entry)) {
                    $entries[$index] = $change($entry);
                    $found = true;
                    break;
                }
            }
            if ($found) {
                $this->seal($import, $entries);
                $this->entityManager->flush();
            }

            return $found;
        });
    }

    /**
     * @param list<ImportEntry> $entries
     */
    private function seal(MailAccountImport $import, array $entries): void
    {
        $json = json_encode(array_map(static fn (ImportEntry $entry): array => $entry->toArray(), $entries), \JSON_THROW_ON_ERROR | \JSON_UNESCAPED_UNICODE);
        $import->sealEntries($this->vault->seal($import->getOwner()->getId(), self::context($import->getId()), $json));
    }

    /**
     * An address as a list stores it (lowercase, its domain in ASCII), so a mail account stored with its domain in
     * Unicode matches its entry. One that is no address by the list's rule stays as it is.
     */
    public static function spelling(string $address): string
    {
        return ImportAddress::normalize($address, true) ?? mb_strtolower($address);
    }

    /**
     * @return array<string, true>
     */
    private function connectedAddresses(User $owner): array
    {
        $addresses = [];
        foreach ($this->mailAccounts->findOwnedBy($owner) as $account) {
            $addresses[self::spelling($account->getEmailAddress())] = true;
        }

        return $addresses;
    }
}
