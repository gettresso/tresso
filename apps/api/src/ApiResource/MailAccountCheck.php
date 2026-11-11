<?php

declare(strict_types=1);

namespace App\ApiResource;

use ApiPlatform\Metadata\ApiProperty;
use ApiPlatform\Metadata\ApiResource;
use ApiPlatform\Metadata\Post;
use App\ApiResource\Input\CheckMailAccount;
use App\Security\FirstPartyClients;
use App\Security\Scope;
use App\State\MailAccountCheckProcessor;

/**
 * Checks an IMAP/SMTP account before it is created (POST /api/v1/mail-accounts): signs in to the IMAP server and
 * lists its folders, then signs in to the SMTP server, each within 15 seconds, with the rules the sync workers
 * connect by (public addresses only, TLS verified for the host name). Nothing is stored, and nothing is sent.
 *
 * `imap` and `smtp` are ok, auth_failed (the server refused the username or password), unreachable (not found, refused
 * or no answer), certificate (TLS certificate not valid for the host), blocked (private address), failed (the server
 * answered, but not as expected) or not_checked (SMTP, when IMAP failed). `detail` is one technical line about what
 * failed. Our own apps only, and at most 20 checks per user in 10 minutes.
 */
#[ApiResource(
    shortName: 'MailAccountCheck',
    routePrefix: '/api/v1',
    normalizationContext: ['skip_null_values' => false],
    operations: [
        new Post(
            uriTemplate: '/mail-account-checks',
            status: 200,
            security: "is_granted('".Scope::ROLE_SETTINGS_WRITE."') and is_granted('".FirstPartyClients::ATTRIBUTE."')",
            input: CheckMailAccount::class,
            read: false,
            processor: MailAccountCheckProcessor::class,
        ),
    ],
)]
final readonly class MailAccountCheck
{
    public function __construct(
        #[ApiProperty(identifier: true)]
        public string $emailAddress,
        public string $imap,
        public string $smtp,
        public ?int $folders,
        public ?string $detail,
    ) {
    }
}
