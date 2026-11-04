<?php

declare(strict_types=1);

namespace App\ProviderAuth;

use App\Enum\ProviderReturnTarget;

/**
 * Where the browser goes when a provider sends it back: a page of the web app plus its query, reached in the web app
 * itself or, for a sign-in the desktop app started, through the desktop app's link.
 */
final readonly class ConnectResult
{
    /**
     * @param array<string, string> $query
     */
    public function __construct(
        public string $path,
        public array $query,
        public ProviderReturnTarget $target = ProviderReturnTarget::Web,
    ) {
    }
}
