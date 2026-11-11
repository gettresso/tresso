<?php

declare(strict_types=1);

namespace App\Tests\Unit\Mail\Check;

use App\Mail\Check\CheckFailed;
use App\Mail\Check\CheckStatus;
use App\Mail\Check\LineConnection;

/**
 * A mail server conversation played from a script: the lines the server sends, and a record of what the client wrote.
 * Answers are handed out in order; running out reads as a closed connection.
 */
final class ScriptedConnection implements LineConnection
{
    /** @var list<string> */
    public array $written = [];

    public bool $tls = false;

    public bool $closed = false;

    /**
     * @param list<string> $lines what the server says, in order
     */
    public function __construct(private array $lines)
    {
    }

    public function readLine(): string
    {
        if ([] === $this->lines) {
            throw new CheckFailed(CheckStatus::Unreachable, 'The connection was closed (test).');
        }

        return array_shift($this->lines);
    }

    public function write(string $data): void
    {
        $this->written[] = $data;
    }

    public function startTls(): void
    {
        $this->tls = true;
    }

    public function close(): void
    {
        $this->closed = true;
    }
}
