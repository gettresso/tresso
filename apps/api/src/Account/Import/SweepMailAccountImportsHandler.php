<?php

declare(strict_types=1);

namespace App\Account\Import;

use Symfony\Component\Messenger\Attribute\AsMessageHandler;

/**
 * An expired list is never shown again (the API answers 404 for it); this removes it, with its sealed addresses.
 */
#[AsMessageHandler]
final readonly class SweepMailAccountImportsHandler
{
    public function __construct(private MailAccountImports $imports)
    {
    }

    public function __invoke(SweepMailAccountImports $message): int
    {
        return $this->imports->sweep();
    }
}
