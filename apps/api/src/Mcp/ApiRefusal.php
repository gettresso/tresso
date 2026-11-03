<?php

declare(strict_types=1);

namespace App\Mcp;

/**
 * The API refused what a tool asked (a 4xx): the tool reports it to the model as a tool error, in the API's own words.
 */
final class ApiRefusal extends \RuntimeException
{
    /**
     * @param list<array{field: string, message: string}> $violations
     */
    public function __construct(
        public readonly int $status,
        public readonly string $detail,
        public readonly array $violations = [],
    ) {
        parent::__construct($detail);
    }

    /**
     * What went wrong, for the model and the person reading along: the kind of refusal, the API's message and every
     * field it did not accept.
     */
    public function explain(): string
    {
        $lines = [match (true) {
            401 === $this->status => 'Not signed in: '.$this->detail,
            402 === $this->status => 'Payment required: '.$this->detail,
            403 === $this->status => 'Not allowed: '.$this->detail,
            404 === $this->status => 'Not found: nothing with that id exists for this user.',
            409 === $this->status => 'Conflict: '.$this->detail,
            422 === $this->status && [] !== $this->violations => 'Some values were not accepted:',
            default => \sprintf('Refused (%d): %s', $this->status, $this->detail),
        }];

        foreach ($this->violations as $violation) {
            $lines[] = '' === $violation['field']
                ? '- '.$violation['message']
                : \sprintf('- %s: %s', $violation['field'], $violation['message']);
        }

        return implode("\n", $lines);
    }
}
