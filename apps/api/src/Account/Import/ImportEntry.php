<?php

declare(strict_types=1);

namespace App\Account\Import;

use App\Enum\ImportFailure;
use App\Enum\ImportProviderHint;

/**
 * One address of a {@see \App\Entity\MailAccountImport}, as stored (sealed) in its list. Whether it is connected is not
 * stored: {@see MailAccountImports::view()} reads that from the owner's mail accounts.
 */
final readonly class ImportEntry
{
    public function __construct(
        public string $id,
        /** Lowercase, as mail accounts store addresses. */
        public string $address,
        public ?ImportProviderHint $provider,
        public bool $skipped = false,
        /** Why the last sign-in for this address failed; cleared when the user starts again or skips it. */
        public ?ImportFailure $failure = null,
    ) {
    }

    public function with(bool $skipped, ?ImportFailure $failure): self
    {
        return new self($this->id, $this->address, $this->provider, $skipped, $failure);
    }

    /**
     * @return array{id: string, address: string, provider: ?string, skipped: bool, failure: ?string}
     */
    public function toArray(): array
    {
        return [
            'id' => $this->id,
            'address' => $this->address,
            'provider' => $this->provider?->value,
            'skipped' => $this->skipped,
            'failure' => $this->failure?->value,
        ];
    }

    /**
     * @param array<mixed> $data
     */
    public static function fromArray(array $data): self
    {
        $id = $data['id'] ?? null;
        $address = $data['address'] ?? null;
        if (!\is_string($id) || !\is_string($address)) {
            throw new \UnexpectedValueException('A stored import entry has no id or address.');
        }
        $provider = $data['provider'] ?? null;
        $failure = $data['failure'] ?? null;

        return new self(
            $id,
            $address,
            \is_string($provider) ? ImportProviderHint::tryFrom($provider) : null,
            true === ($data['skipped'] ?? false),
            \is_string($failure) ? ImportFailure::tryFrom($failure) : null,
        );
    }
}
