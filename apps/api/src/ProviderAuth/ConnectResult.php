<?php

declare(strict_types=1);

namespace App\ProviderAuth;

/**
 * Where the browser goes when a provider sends it back: a path of the web app plus its query.
 */
final readonly class ConnectResult
{
    /**
     * @param array<string, string> $query
     */
    public function __construct(
        public string $path,
        public array $query,
    ) {
    }
}
