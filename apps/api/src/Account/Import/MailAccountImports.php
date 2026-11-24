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
use App\Security\Crypto\FieldVault;
use Doctrine\DBAL\LockMode;
use Doctrine\ORM\EntityManagerInterface;
use Psr\Clock\ClockInterface;
use Symfony\Component\Uid\Uuid;
use Symfony\Component\Validator\Constraints as Assert;
use Symfony\Component\Validator\Validator\ValidatorInterface;

/**
 * Mail account import lists: a short list of addresses the user wants to add, which the user then connects one by one
 * on the web app's page for it. Making a list connects nothing and asks for no password; every address is connected by
 * the user, through the same sign-in or server form as a single account.
 *
 * The entries are sealed with the owner's field key, bound to the list's row ({@see self::context()}). An entry counts
 * as connected while the owner has a mail account with its address, read whenever the list is read, never stored.
 * Addresses never go to a log.
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
        private ValidatorInterface $validator,
        private ClockInterface $clock,
    ) {
    }

    /** The context the entries of list $id are sealed for. */
    public static function context(Uuid $id): string
    {
        return 'tresso:'.self::FIELD.':'.$id->toRfc4122();
    }

    /**
     * Sorts what was asked for into entries to take and addresses left out (not an address, given twice, connected
     * already), each with the reason. Nothing is stored.
     *
     * @param list<array{address: string, provider: ?ImportProviderHint}> $asked
     *
     * @return array{taken: list<ImportEntry>, leftOut: list<array{index: int, address: string, reason: string, message: string}>}
     */
    public function sort(User $owner, array $asked): array
    {
        $connected = $this->connectedAddresses($owner);
        $taken = [];
        $seen = [];
        $leftOut = [];
        foreach ($asked as $index => $entry) {
            $address = mb_strtolower(trim($entry['address']));
            if (!$this->isAddress($address)) {
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
     * @param non-empty-list<ImportEntry> $entries
     * @param string|null                 $createdBy the app that made it, when it is not one of Tresso's own
     */
    public function create(User $owner, array $entries, ?string $createdBy): MailAccountImport
    {
        $import = new MailAccountImport($owner, $createdBy, $this->clock->now());
        $this->seal($import, $entries);
        $this->entityManager->persist($import);
        $this->entityManager->flush();

        return $import;
    }

    public function liveListsOf(User $owner): int
    {
        return $this->imports->countLiveOwnedBy($owner, $this->clock->now());
    }

    /** The owner's list while it lives; null for another user's list, an unknown id, or one that expired. */
    public function find(User $owner, string $id): ?MailAccountImport
    {
        return $this->imports->findLiveOwnedBy($owner, $id, $this->clock->now());
    }

    /**
     * The owner's lists that live, newest first.
     *
     * @return list<MailAccountImport>
     */
    public function liveOf(User $owner): array
    {
        return $this->imports->findAllLiveOwnedBy($owner, $this->clock->now());
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
            $accounts[$account->getEmailAddress()] = $account;
        }

        return array_map(static function (ImportEntry $entry) use ($accounts): array {
            $account = $accounts[$entry->address] ?? null;
            $state = match (true) {
                null !== $account => ImportEntryState::Connected,
                $entry->skipped => ImportEntryState::Skipped,
                null !== $entry->failure => ImportEntryState::Failed,
                default => ImportEntryState::Todo,
            };

            return ['entry' => $entry, 'state' => $state, 'account' => $account];
        }, $this->entries($import));
    }

    /**
     * Sets an entry to skipped, back to do (clearing a failure), or failed with a reason. False when the list has no
     * such entry.
     */
    public function mark(MailAccountImport $import, string $entryId, ImportEntryState $state, ?ImportFailure $failure): bool
    {
        if (ImportEntryState::Connected === $state) {
            throw new \InvalidArgumentException('Connected is read from the mail accounts, never set.');
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
        $address = mb_strtolower($address);
        $this->change(
            $import->getId(),
            static fn (ImportEntry $entry): bool => $entry->address === $address,
            static fn (ImportEntry $entry): ImportEntry => $entry->with(null === $error ? $entry->skipped : false, null === $error ? null : ImportFailure::fromConnectError($error)),
        );
    }

    /** Whether the owner's live list $importId holds $address. */
    public function holds(User $owner, string $importId, string $address): bool
    {
        $import = $this->find($owner, $importId);
        if (null === $import) {
            return false;
        }
        $address = mb_strtolower(trim($address));

        return [] !== array_filter($this->entries($import), static fn (ImportEntry $entry): bool => $entry->address === $address);
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

    private function isAddress(string $address): bool
    {
        return '' !== $address && 0 === \count($this->validator->validate($address, [
            new Assert\Email(mode: Assert\Email::VALIDATION_MODE_STRICT),
            new Assert\Length(max: 320),
        ]));
    }

    /**
     * @return array<string, true>
     */
    private function connectedAddresses(User $owner): array
    {
        $addresses = [];
        foreach ($this->mailAccounts->findOwnedBy($owner) as $account) {
            $addresses[$account->getEmailAddress()] = true;
        }

        return $addresses;
    }
}
