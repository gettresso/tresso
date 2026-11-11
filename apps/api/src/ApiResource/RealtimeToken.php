<?php

declare(strict_types=1);

namespace App\ApiResource;

use ApiPlatform\Metadata\ApiProperty;
use ApiPlatform\Metadata\ApiResource;
use ApiPlatform\Metadata\Get;
use App\Security\Scope;
use App\State\RealtimeTokenProvider;

/**
 * Access to the realtime hub. Subscribe with GET `{hubUrl}?match={topic}` and `token` in the `Authorization: Bearer`
 * header (browsers stream through fetch(); the hub takes no token in the URL). Each update carries
 * `{"cursor": N}`: fetch the delta when N is beyond the local cursor. Fetch a new token before `expiresAt`. The hub
 * sends a comment line every `heartbeat` seconds on an idle stream, so a stream silent for much longer is dead.
 */
#[ApiResource(
    shortName: 'RealtimeToken',
    routePrefix: '/api/v1',
    operations: [
        new Get(
            uriTemplate: '/realtime/token',
            uriVariables: [],
            security: "is_granted('".Scope::ROLE_MAIL_READ."')",
            provider: RealtimeTokenProvider::class,
        ),
    ],
)]
final readonly class RealtimeToken
{
    public function __construct(
        public string $hubUrl,
        #[ApiProperty(identifier: true)]
        public string $topic,
        public string $token,
        public \DateTimeImmutable $expiresAt,
        public int $heartbeat,
    ) {
    }
}
