<?php

declare(strict_types=1);

namespace App\ApiResource\Input\MailAccountImport;

use App\Enum\ImportEntryState;
use App\Enum\ImportFailure;
use Symfony\Component\Validator\Constraints as Assert;

/**
 * Marks one entry of an import list: skipped, back to do, or failed with a reason code (for the server form; a failed
 * provider sign-in is recorded by the API itself). Connected is never set: it follows from the mail accounts.
 */
final class UpdateImportEntry
{
    #[Assert\NotBlank]
    #[Assert\Uuid]
    public ?string $entryId = null;

    #[Assert\NotNull]
    #[Assert\Choice(choices: [ImportEntryState::Todo, ImportEntryState::Skipped, ImportEntryState::Failed], message: 'Set an entry to todo, skipped or failed; connected follows from the mail accounts.')]
    public ?ImportEntryState $state = null;

    /** Only with the state failed; the processor refuses it otherwise. */
    public ?ImportFailure $failure = null;
}
