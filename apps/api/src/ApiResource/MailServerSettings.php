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
 * are never suggested.
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
    ) {
    }
}
