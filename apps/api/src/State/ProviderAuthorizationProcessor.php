<?php

declare(strict_types=1);

namespace App\State;

use ApiPlatform\Metadata\Operation;
use ApiPlatform\State\ProcessorInterface;
use ApiPlatform\Validator\Exception\ValidationException;
use App\ApiResource\Input\StartProviderAuthorization;
use App\ApiResource\ProviderAuthorization;
use App\Entity\MailAccount;
use App\Enum\OAuthProvider;
use App\Enum\ProviderFeature;
use App\Enum\ProviderReturnTarget;
use App\ProviderAuth\ProviderConnector;
use App\ProviderAuth\ProviderSettings;
use App\Repository\MailAccountRepository;
use App\Security\CurrentUser;
use Symfony\Component\DependencyInjection\Attribute\Autowire;
use Symfony\Component\Validator\ConstraintViolation;
use Symfony\Component\Validator\ConstraintViolationList;

/**
 * @implements ProcessorInterface<StartProviderAuthorization, ProviderAuthorization>
 */
final readonly class ProviderAuthorizationProcessor implements ProcessorInterface
{
    public function __construct(
        private ProviderConnector $connector,
        private ProviderSettings $settings,
        private MailAccountRepository $mailAccounts,
        private CurrentUser $currentUser,
        #[Autowire(env: 'NATIVE_REDIRECT_URI')]
        private string $nativeRedirectUri,
    ) {
    }

    public function process(mixed $data, Operation $operation, array $uriVariables = [], array $context = []): ProviderAuthorization
    {
        $owner = $this->currentUser->get();
        $provider = $data->provider ?? throw new \LogicException('Validation guarantees a provider.');

        if (!$this->settings->isConfigured($provider)) {
            throw self::violation($data, 'provider', \sprintf('Signing in with %s is not set up on this server.', $provider->label()), $provider->value);
        }

        if (ProviderReturnTarget::Native === $data->returnTo && '' === $this->nativeRedirectUri) {
            throw self::violation($data, 'returnTo', 'This server has no link back to the desktop app (NATIVE_REDIRECT_URI).', $data->returnTo->value);
        }

        $mailAccount = null;
        if (null !== $data->mailAccountId) {
            $mailAccount = $this->mailAccounts->findOneOwnedBy($owner, $data->mailAccountId);
            if (!$mailAccount instanceof MailAccount) {
                throw self::violation($data, 'mailAccountId', 'Mail account not found.', $data->mailAccountId);
            }
            if (OAuthProvider::forMailProvider($mailAccount->getProvider()) !== $provider) {
                throw self::violation($data, 'mailAccountId', \sprintf('This account does not sign in with %s.', $provider->label()), $data->mailAccountId);
            }
        }

        if (null === $mailAccount && !\in_array(ProviderFeature::Mail, $data->features, true)) {
            // Calendars sync with the mail account they belong to.
            throw self::violation($data, 'features', 'Allow calendars for a connected account: name it in mailAccountId, or ask for mail too.', implode(',', array_map(static fn (ProviderFeature $feature): string => $feature->value, $data->features)));
        }

        $started = $this->connector->start($owner, $provider, $data->features, $mailAccount, $data->returnTo);

        return new ProviderAuthorization($started['url'], $provider->value, $started['expiresAt']);
    }

    private static function violation(StartProviderAuthorization $input, string $path, string $message, string $value): ValidationException
    {
        return new ValidationException(new ConstraintViolationList([new ConstraintViolation($message, null, [], $input, $path, $value)]));
    }
}
