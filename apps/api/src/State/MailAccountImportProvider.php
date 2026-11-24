<?php

declare(strict_types=1);

namespace App\State;

use ApiPlatform\Metadata\CollectionOperationInterface;
use ApiPlatform\Metadata\Operation;
use ApiPlatform\State\ProviderInterface;
use App\Account\Import\ImportPages;
use App\Account\Import\MailAccountImports;
use App\ApiResource\MailAccountImportResource;
use App\Entity\MailAccountImport;
use App\Enum\ImportEntryState;
use App\Enum\ImportFailure;
use App\ProviderAuth\ProviderSettings;
use App\Security\CurrentUser;
use Symfony\Component\HttpKernel\Exception\NotFoundHttpException;

/**
 * Only ever returns the signed-in user's own import lists, and only while they live: another user's list and one that
 * expired are both not found.
 *
 * @implements ProviderInterface<MailAccountImportResource>
 */
final readonly class MailAccountImportProvider implements ProviderInterface
{
    public function __construct(
        private MailAccountImports $imports,
        private ImportPages $pages,
        private ProviderSettings $providerSettings,
        private CurrentUser $currentUser,
    ) {
    }

    /**
     * @return MailAccountImportResource|list<MailAccountImportResource>
     */
    public function provide(Operation $operation, array $uriVariables = [], array $context = []): MailAccountImportResource|array
    {
        $owner = $this->currentUser->get();

        if ($operation instanceof CollectionOperationInterface) {
            return array_map(fn (MailAccountImport $import): MailAccountImportResource => $this->resource($import), $this->imports->liveOf($owner));
        }

        $id = $uriVariables['id'] ?? null;
        $import = \is_string($id) ? $this->imports->find($owner, $id) : null;
        if (!$import instanceof MailAccountImport) {
            throw new NotFoundHttpException('Import list not found.');
        }

        return $this->resource($import);
    }

    /**
     * @param list<array{address: string, reason: string, message: string}> $leftOut
     */
    public function resource(MailAccountImport $import, array $leftOut = []): MailAccountImportResource
    {
        $entries = [];
        $progress = ['todo' => 0, 'connected' => 0, 'already_connected' => 0, 'failed' => 0, 'skipped' => 0];
        foreach ($this->imports->view($import) as ['entry' => $entry, 'state' => $state, 'account' => $account]) {
            ++$progress[$state->value];
            $failure = ImportEntryState::Failed === $state ? $entry->failure : null;
            $entries[] = [
                'id' => $entry->id,
                'address' => $entry->address,
                'provider' => $entry->provider?->value,
                'state' => $state->value,
                'failure' => $failure?->value,
                'reason' => $failure?->reason(),
                'mailAccountId' => $account?->getId()->toRfc4122(),
                'accountStatus' => $account?->getStatus()->value,
                // Where the organization's administrator approves Tresso, for the row and "Copy approval link".
                'approvalUrl' => ImportFailure::AdminApprovalRequired === $failure ? $this->providerSettings->adminConsentUrl($entry->address) : null,
            ];
        }

        return new MailAccountImportResource(
            $import->getId()->toRfc4122(),
            $entries,
            $progress,
            $import->getCreatedBy(),
            $this->pages->importPage($import->getId()),
            $import->getCreatedAt(),
            $import->getExpiresAt(),
            $leftOut,
        );
    }
}
