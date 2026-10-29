<?php

declare(strict_types=1);

namespace App\ApiResource;

use ApiPlatform\Metadata\ApiProperty;
use ApiPlatform\Metadata\ApiResource;
use ApiPlatform\Metadata\Get;
use App\State\ServerInfoProvider;

/**
 * What this server is, for an app to check before it signs in: always open, also to someone whose subscription
 * stopped. `billing` says whether this server bills its organizations (Tresso Cloud) or not (a self-hosted server).
 */
#[ApiResource(
    shortName: 'ServerInfo',
    routePrefix: '/api/v1',
    operations: [
        new Get(uriTemplate: '/server-info', uriVariables: [], provider: ServerInfoProvider::class),
    ],
)]
final readonly class ServerInfo
{
    public const string PRODUCT = 'tresso-server';
    public const int API_VERSION = 1;

    public function __construct(
        #[ApiProperty(identifier: true)]
        public string $product,
        /** Raised only when an older app can no longer work with this server. */
        public int $apiVersion,
        public bool $billing,
        /** Days of free trial a new organization gets on a billing server; 0 elsewhere. */
        public int $trialDays,
    ) {
    }
}
