<?php

declare(strict_types=1);

namespace App\State;

use ApiPlatform\Metadata\DeleteOperationInterface;
use ApiPlatform\Metadata\Operation;
use ApiPlatform\State\ProcessorInterface;
use ApiPlatform\Validator\Exception\ValidationException;
use App\Account\Import\ImportPages;
use App\Account\Import\MailAccountImports;
use App\ApiResource\Input\MailAccountImport\CreateMailAccountImport;
use App\ApiResource\Input\MailAccountImport\NewImportEntry;
use App\ApiResource\Input\MailAccountImport\UpdateImportEntry;
use App\ApiResource\MailAccountImportResource;
use App\Entity\MailAccountImport;
use App\Entity\User;
use App\Enum\ImportEntryState;
use App\Repository\PersonalAccessTokenRepository;
use App\Security\CallerKey;
use App\Security\CurrentUser;
use App\Security\FirstPartyClients;
use App\Security\PersonalAccessToken\PersonalAccessTokenAuthentication;
use League\Bundle\OAuth2ServerBundle\Manager\ClientManagerInterface;
use League\Bundle\OAuth2ServerBundle\Security\Authentication\Token\OAuth2Token;
use Symfony\Bundle\SecurityBundle\Security;
use Symfony\Component\HttpKernel\Exception\ConflictHttpException;
use Symfony\Component\HttpKernel\Exception\NotFoundHttpException;
use Symfony\Component\HttpKernel\Exception\ServiceUnavailableHttpException;
use Symfony\Component\Validator\ConstraintViolation;
use Symfony\Component\Validator\ConstraintViolationList;

/**
 * Makes, marks and deletes the signed-in user's import lists. Making one takes what it can and names what it left out
 * per address; a list with nothing to take is refused with a violation per address.
 *
 * @implements ProcessorInterface<CreateMailAccountImport|UpdateImportEntry|MailAccountImportResource, MailAccountImportResource|null>
 */
final readonly class MailAccountImportProcessor implements ProcessorInterface
{
    public function __construct(
        private MailAccountImports $imports,
        private MailAccountImportProvider $provider,
        private ImportPages $pages,
        private CurrentUser $currentUser,
        private Security $security,
        private ClientManagerInterface $clients,
        private PersonalAccessTokenRepository $personalAccessTokens,
    ) {
    }

    public function process(mixed $data, Operation $operation, array $uriVariables = [], array $context = []): ?MailAccountImportResource
    {
        $owner = $this->currentUser->get();

        if ($data instanceof CreateMailAccountImport) {
            return $this->create($owner, $data);
        }

        $id = $uriVariables['id'] ?? null;
        $import = \is_string($id) ? $this->imports->find($owner, $id, $this->provider->caller()) : null;
        if (!$import instanceof MailAccountImport) {
            throw new NotFoundHttpException('Import list not found.');
        }

        if ('mail_account_import_confirmation' === $operation->getName()) {
            $this->imports->confirm($import);

            return $this->provider->resource($import);
        }

        if ($operation instanceof DeleteOperationInterface) {
            $this->imports->delete($import);

            return null;
        }

        if ($data instanceof UpdateImportEntry) {
            $state = $data->state ?? throw new \LogicException('Validation guarantees a state.');
            if (null !== $data->failure && ImportEntryState::Failed !== $state) {
                throw self::violation($data, 'failure', 'A reason goes with the state failed only.', $data->failure->value);
            }
            if (!$this->imports->mark($import, (string) $data->entryId, $state, $data->failure)) {
                throw ImportEntryState::Connected === $state
                    ? self::violation($data, 'state', 'This list has no such entry, or its address has no mail account yet.', $state->value)
                    : self::violation($data, 'entryId', 'This list has no such entry.', (string) $data->entryId);
            }

            return $this->provider->resource($import);
        }

        throw new \LogicException(\sprintf('Unexpected input %s for %s.', get_debug_type($data), $operation->getName()));
    }

    private function create(User $owner, CreateMailAccountImport $input): MailAccountImportResource
    {
        // A list nobody can open is not made: checked before anything is stored.
        if (!$this->pages->available()) {
            throw new ServiceUnavailableHttpException(null, 'This server has no address for its web app (WEB_APP_URL), so there is no page to add the accounts on.');
        }

        $caller = $this->provider->caller();
        $asked = array_map(static fn (NewImportEntry $entry): array => ['address' => (string) $entry->address, 'provider' => $entry->provider], $input->entries);
        ['taken' => $taken, 'leftOut' => $leftOut] = $this->imports->sort($owner, $asked, CallerKey::OURS === $caller);

        if ([] === $taken) {
            $violations = new ConstraintViolationList();
            foreach ($leftOut as $left) {
                $violations->add(new ConstraintViolation($left['message'], null, [], $input, \sprintf('entries[%d].address', $left['index']), $left['address']));
            }

            throw new ValidationException($violations);
        }

        $import = $this->imports->create($owner, $taken, $this->creatorName(), $caller);
        if (null === $import) {
            throw new ConflictHttpException(\sprintf('You have %d import lists already. Finish or delete one before making another.', MailAccountImports::MAX_LIVE_LISTS));
        }

        return $this->provider->resource($import, array_map(
            static fn (array $left): array => ['address' => $left['address'], 'reason' => $left['reason'], 'message' => $left['message']],
            $leftOut,
        ));
    }

    /**
     * The app making the list, for the page to name in "This list was made by ...": null for Tresso's own apps, the
     * app's registered name for an app the user allowed, and the token's name for a personal access token.
     */
    private function creatorName(): ?string
    {
        $token = $this->security->getToken();
        if (FirstPartyClients::signedRequest($token)) {
            return null;
        }
        if ($token instanceof PersonalAccessTokenAuthentication) {
            $owner = $this->currentUser->get();
            $name = $this->personalAccessTokens->findOneOwnedBy($owner, $token->getPersonalAccessTokenId())?->getName();

            return mb_substr(null === $name ? 'your personal access token' : \sprintf('your personal access token "%s"', $name), 0, 200);
        }
        if ($token instanceof OAuth2Token) {
            $name = $this->clients->find($token->getOAuthClientId())?->getName();

            return mb_substr(null === $name || '' === trim($name) ? 'an app you allowed' : trim($name), 0, 200);
        }

        return 'an app you allowed';
    }

    private static function violation(object $input, string $path, string $message, string $value): ValidationException
    {
        return new ValidationException(new ConstraintViolationList([new ConstraintViolation($message, null, [], $input, $path, $value)]));
    }
}
