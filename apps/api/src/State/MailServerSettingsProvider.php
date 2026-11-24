<?php

declare(strict_types=1);

namespace App\State;

use ApiPlatform\Metadata\Operation;
use ApiPlatform\State\ProviderInterface;
use ApiPlatform\Validator\Exception\ValidationException;
use App\Account\Import\MailAccountImports;
use App\ApiResource\MailServerSettings;
use App\Mail\Autoconfig\ServerSettingsDetector;
use App\Security\CurrentUser;
use Symfony\Component\HttpFoundation\RequestStack;
use Symfony\Component\Validator\ConstraintViolation;
use Symfony\Component\Validator\ConstraintViolationList;

/**
 * @implements ProviderInterface<MailServerSettings>
 */
final readonly class MailServerSettingsProvider implements ProviderInterface
{
    public function __construct(
        private ServerSettingsDetector $detector,
        private RequestStack $requests,
        private MailAccountImports $imports,
        private CurrentUser $currentUser,
    ) {
    }

    public function provide(Operation $operation, array $uriVariables = [], array $context = []): MailServerSettings
    {
        $query = $this->requests->getCurrentRequest()?->query;
        $emailAddress = mb_strtolower(trim((string) $query?->get('emailAddress')));
        $importId = $query?->get('importId');
        if (\is_string($importId) && '' !== $importId && !$this->imports->holds($this->currentUser->get(), $importId, $emailAddress)) {
            throw new ValidationException(new ConstraintViolationList([new ConstraintViolation('This import list does not hold this address, has not been confirmed, or expired.', null, [], null, 'importId', $importId)]));
        }
        $provider = $this->detector->provider($emailAddress)?->value;
        $detected = $this->detector->detect($emailAddress);
        if (null === $detected) {
            return new MailServerSettings($emailAddress, false, null, null, null, null, [], $provider);
        }

        // A provider whose autoconfig named one particular user (instead of the %EMAILADDRESS% placeholder) must not
        // hand that address to someone else of the same domain.
        $username = $detected->username;
        if (str_contains($username, '@') && $username !== $emailAddress) {
            $username = $emailAddress;
        }

        return new MailServerSettings($emailAddress, true, $detected->source, $username, $detected->imap, $detected->smtp, $detected->authentication, $provider);
    }
}
