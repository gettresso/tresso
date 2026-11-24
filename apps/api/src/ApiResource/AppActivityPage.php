<?php

declare(strict_types=1);

namespace App\ApiResource;

use ApiPlatform\Metadata\ApiResource;
use ApiPlatform\Metadata\Get;
use App\Security\FirstPartyClients;
use App\Security\Scope;
use App\State\AppActivityProvider;

/**
 * The activity log of the signed-in user: what apps that are not ours (connected apps and personal access tokens) did
 * through MCP and the API, newest first, a page at a time. Only our own apps may read it.
 *
 * Query: `period` (`24h`, `7d`, `30d` or `90d`, the default), `app` (an `activityKey` of a connected app or a personal
 * access token: `client:<id>`, `token:<id>`), `kind` (`read`, `change`, `send`), `result` (`done`, `refused`,
 * `failed`), `limit` (1 to 100, default 50) and `cursor` (the `nextCursor` of the page before; null on the last page).
 * `apps` lists every app that has entries, with its name, for the app filter. An entry holds no content: see
 * {@see \App\Entity\AppActivity}.
 */
#[ApiResource(
    shortName: 'AppActivity',
    routePrefix: '/api/v1',
    normalizationContext: ['skip_null_values' => false],
    operations: [
        new Get(
            uriTemplate: '/app-activity',
            uriVariables: [],
            security: "is_granted('".Scope::ROLE_SETTINGS_READ."') and is_granted('".FirstPartyClients::ATTRIBUTE."')",
            provider: AppActivityProvider::class,
        ),
    ],
)]
final readonly class AppActivityPage
{
    /**
     * @param list<array<string, mixed>>                                   $items
     * @param list<array{key: string, type: string, name: string|null}> $apps
     */
    public function __construct(
        public array $items,
        public ?string $nextCursor,
        public array $apps,
    ) {
    }
}
