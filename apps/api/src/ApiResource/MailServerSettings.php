<?php

declare(strict_types=1);

namespace App\ApiResource;

use ApiPlatform\Metadata\ApiProperty;
use ApiPlatform\Metadata\ApiResource;
use ApiPlatform\Metadata\Get;
use ApiPlatform\Metadata\QueryParameter;
use App\Mail\ServerSettings;
use App\Security\FirstPartyClients;
use App\Security\Scope;
use App\State\MailServerSettingsProvider;
use Symfony\Component\Validator\Constraints as Assert;

/**
 * Suggested IMAP and SMTP settings for an address, to fill in the form for a new mail account. Found through the
 * provider's own autoconfig or Mozilla's ISPDB; `found` is false when nothing is known and the user has to enter the
 * settings. `authentication` lists how the provider lets users sign in ("password", "oauth2"). Unencrypted servers
 * are never suggested. `provider` names the large provider that handles the address, by its domain or its mail
 * exchanger (google, outlook, m365, icloud, yahoo; null for any other), so the client can offer the easiest way to
 * connect it: the provider's own sign-in page, or an app password.
 *
 * For an address of an import list (`importId`), the list must be the user's, live, confirmed and hold the address: an
 * address an app put on a list is not looked up (its domain asked for servers) before the user chose to use it.
 */
#[ApiResource(
    shortName: 'MailServerSettings',
    routePrefix: '/api/v1',
    operations: [
        new Get(
            uriTemplate: '/mail-server-settings',
            uriVariables: [],
            security: "is_granted('".Scope::ROLE_SETTINGS_WRITE."') and is_granted('".FirstPartyClients::ATTRIBUTE."')",
            provider: MailServerSettingsProvider::class,
            normalizationContext: ['skip_null_values' => false],
            parameters: [
                'emailAddress' => new QueryParameter(
                    schema: ['type' => 'string', 'format' => 'email'],
                    required: true,
                    description: 'The address of the account to connect.',
                    constraints: [new Assert\NotBlank(), new Assert\Email(mode: Assert\Email::VALIDATION_MODE_STRICT), new Assert\Length(max: 320)],
                ),
                'importId' => new QueryParameter(
                    schema: ['type' => 'string', 'format' => 'uuid'],
                    required: false,
                    description: 'The import list the address is from: looked up only once the user confirmed a list an app made.',
                    constraints: [new Assert\Uuid()],
                ),
            ],
        ),
    ],
)]
final readonly class MailServerSettings
{
    /**
     * @param list<string> $authentication
     */
    public function __construct(
        #[ApiProperty(identifier: true)]
        public string $emailAddress,
        public bool $found,
        public ?string $source,
        public ?string $username,
        public ?ServerSettings $imap,
        public ?ServerSettings $smtp,
        public array $authentication,
        /** google, outlook (Outlook.com, Hotmail, Live), m365 (Microsoft 365 work or school), icloud, yahoo, or null */
        public ?string $provider = null,
    ) {
    }
}
