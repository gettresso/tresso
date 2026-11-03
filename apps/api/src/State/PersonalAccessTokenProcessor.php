<?php

declare(strict_types=1);

namespace App\State;

use ApiPlatform\Metadata\DeleteOperationInterface;
use ApiPlatform\Metadata\Operation;
use ApiPlatform\State\ProcessorInterface;
use ApiPlatform\Validator\Exception\ValidationException;
use App\ApiResource\Input\CreatePersonalAccessToken;
use App\ApiResource\Output\CreatedPersonalAccessToken;
use App\ApiResource\PersonalAccessTokenResource;
use App\Repository\PersonalAccessTokenRepository;
use App\Security\CurrentUser;
use App\Security\PersonalAccessToken\PersonalAccessTokens;
use App\Security\Scope;
use Doctrine\ORM\EntityManagerInterface;
use Psr\Clock\ClockInterface;
use Symfony\Bundle\SecurityBundle\Security;
use Symfony\Component\HttpKernel\Exception\NotFoundHttpException;
use Symfony\Component\Validator\ConstraintViolation;
use Symfony\Component\Validator\ConstraintViolationList;

/**
 * Makes and revokes the signed-in user's personal access tokens.
 *
 * @implements ProcessorInterface<CreatePersonalAccessToken|PersonalAccessTokenResource, CreatedPersonalAccessToken|null>
 */
final readonly class PersonalAccessTokenProcessor implements ProcessorInterface
{
    public function __construct(
        private PersonalAccessTokens $issuer,
        private PersonalAccessTokenRepository $tokens,
        private CurrentUser $currentUser,
        private EntityManagerInterface $entityManager,
        private ClockInterface $clock,
        private Security $security,
    ) {
    }

    public function process(mixed $data, Operation $operation, array $uriVariables = [], array $context = []): ?CreatedPersonalAccessToken
    {
        $owner = $this->currentUser->get();

        if ($data instanceof CreatePersonalAccessToken) {
            $issued = $this->issuer->issue($owner, trim($data->name), $this->grantableScopes($data), $data->expiresInDays);
            $this->entityManager->flush();

            return CreatedPersonalAccessToken::fromIssued($issued);
        }

        if (!$operation instanceof DeleteOperationInterface) {
            throw new \LogicException(\sprintf('Unexpected input %s for %s.', get_debug_type($data), $operation->getName()));
        }

        $id = $uriVariables['id'] ?? null;
        $token = (\is_string($id) ? $this->tokens->findOneOwnedBy($owner, $id) : null)
            ?? throw new NotFoundHttpException('Personal access token not found.');
        $token->revoke($this->clock->now());
        $this->entityManager->flush();

        return null;
    }

    /**
     * A token never gets more than the session that makes it: every scope asked for must be one the caller holds.
     *
     * @return list<Scope>
     */
    private function grantableScopes(CreatePersonalAccessToken $data): array
    {
        $scopes = [];
        $violations = new ConstraintViolationList();
        foreach ($data->scopes as $index => $value) {
            $scope = Scope::from($value);
            if (!$this->security->isGranted($scope->role())) {
                $violations->add(new ConstraintViolation(
                    'A token can only get permissions that you are signed in with here.',
                    null,
                    [],
                    $data,
                    \sprintf('scopes[%d]', $index),
                    $value,
                ));
                continue;
            }
            $scopes[] = $scope;
        }
        if ($violations->count() > 0) {
            throw new ValidationException($violations);
        }

        return $scopes;
    }
}
