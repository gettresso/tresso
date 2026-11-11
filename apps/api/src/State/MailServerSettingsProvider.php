<?php

declare(strict_types=1);

namespace App\State;

use ApiPlatform\Metadata\Operation;
use ApiPlatform\State\ProviderInterface;
use App\ApiResource\MailServerSettings;
use App\Mail\Autoconfig\ServerSettingsDetector;
use Symfony\Component\HttpFoundation\RequestStack;

/**
 * @implements ProviderInterface<MailServerSettings>
 */
final readonly class MailServerSettingsProvider implements ProviderInterface
{
    public function __construct(
        private ServerSettingsDetector $detector,
        private RequestStack $requests,
    ) {
    }

    public function provide(Operation $operation, array $uriVariables = [], array $context = []): MailServerSettings
    {
        $emailAddress = mb_strtolower(trim((string) $this->requests->getCurrentRequest()?->query->get('emailAddress')));
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
