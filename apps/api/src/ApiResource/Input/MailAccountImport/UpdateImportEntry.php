<?php

declare(strict_types=1);

namespace App\ApiResource\Input\MailAccountImport;

use App\Enum\ImportEntryState;
use App\Enum\ImportFailure;
use Symfony\Component\Validator\Constraints as Assert;

/**
 * Marks one entry of an import list: skipped, back to do, failed with a reason code, or connected (added from this
 * list), each for the server form of the page; a provider sign-in is recorded by the API itself. Connected is taken
 * only while the user has a mail account with the address: it says where the account came from, never that it exists.
 */
final class UpdateImportEntry
{
    #[Assert\NotBlank]
    #[Assert\Uuid]
    public ?string $entryId = null;

    #[Assert\NotNull]
    #[Assert\Choice(choices: [ImportEntryState::Todo, ImportEntryState::Skipped, ImportEntryState::Failed, ImportEntryState::Connected], message: 'Set an entry to todo, skipped, failed or connected; already connected follows from the mail accounts.')]
    public ?ImportEntryState $state = null;

    /** Only with the state failed; the processor refuses it otherwise. */
    public ?ImportFailure $failure = null;
}
