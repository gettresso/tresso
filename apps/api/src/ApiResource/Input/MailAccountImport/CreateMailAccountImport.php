<?php

declare(strict_types=1);

namespace App\ApiResource\Input\MailAccountImport;

use App\Entity\MailAccountImport;
use Symfony\Component\Validator\Constraints as Assert;

/**
 * The addresses for a new import list. Addresses that are not an address, are given twice or are connected already are
 * left out one by one, with the reason in the answer; only a list with nothing left to take is refused. Any field
 * besides these is refused: no password, code or token is ever taken here.
 */
final class CreateMailAccountImport
{
    /** @var list<NewImportEntry> */
    #[Assert\Count(min: 1, max: MailAccountImport::MAX_ENTRIES, minMessage: 'Give at least one address.', maxMessage: 'A list holds at most {{ limit }} addresses.')]
    #[Assert\Valid]
    public array $entries = [];
}
