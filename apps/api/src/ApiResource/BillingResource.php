<?php

declare(strict_types=1);

namespace App\ApiResource;

use ApiPlatform\Metadata\ApiProperty;
use ApiPlatform\Metadata\ApiResource;
use ApiPlatform\Metadata\Get;
use ApiPlatform\Metadata\Post;
use App\ApiResource\Input\Billing\BillingCheckoutInput;
use App\ApiResource\Input\Billing\BillingPortalInput;
use App\Security\Scope;
use App\State\BillingProcessor;
use App\State\BillingProvider;

/**
 * The signed-in user's billing. GET says whether they may use the server (`entitled`) and where each of their
 * organizations stands; it stays open when they may not, so an app can show the payment screen. POST
 * /billing/checkout and /billing/portal return a Stripe page (`url`) to pay or to manage the subscription, for an
 * organization the user owns or administers. Reading needs `settings:read`, paying and managing `settings:write`. On a
 * server that does not bill, GET has `enabled: false` and the POSTs answer 404.
 */
#[ApiResource(
    shortName: 'Billing',
    routePrefix: '/api/v1',
    operations: [
        new Get(uriTemplate: '/billing', uriVariables: [], security: "is_granted('".Scope::ROLE_SETTINGS_READ."')", provider: BillingProvider::class),
        new Post(uriTemplate: '/billing/checkout', status: 200, security: "is_granted('".Scope::ROLE_SETTINGS_WRITE."')", input: BillingCheckoutInput::class, output: BillingPage::class, read: false, processor: BillingProcessor::class),
        new Post(uriTemplate: '/billing/portal', status: 200, security: "is_granted('".Scope::ROLE_SETTINGS_WRITE."')", input: BillingPortalInput::class, output: BillingPage::class, read: false, processor: BillingProcessor::class),
    ],
)]
final readonly class BillingResource
{
    /**
     * @param list<string>              $plans         plans this server sells: `monthly`, `yearly`
     * @param list<BillingOrganization> $organizations the user's own personal organization first
     */
    public function __construct(
        #[ApiProperty(identifier: true)]
        public string $userId,
        public bool $enabled,
        /** Whether the user may use the server now; always true where billing is off. */
        public bool $entitled,
        public array $plans,
        public array $organizations,
    ) {
    }
}
