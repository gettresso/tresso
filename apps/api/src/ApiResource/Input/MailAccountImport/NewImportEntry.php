<?php

declare(strict_types=1);

namespace App\ApiResource\Input\MailAccountImport;

use App\Enum\ImportProviderHint;
use Symfony\Component\Validator\Constraints as Assert;

/**
 * One address for a new import list. Whether it is an address is checked per entry when the list is made, so one typo
 * does not refuse the rest.
 */
final class NewImportEntry
{
    #[Assert\NotNull]
    #[Assert\Length(max: 1000)]
    public ?string $address = null;

    /** How the address is expected to connect; only used when looking the address up finds nothing. */
    public ?ImportProviderHint $provider = null;
}
