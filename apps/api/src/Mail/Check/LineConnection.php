<?php

declare(strict_types=1);

namespace App\Mail\Check;

/**
 * A connection to a mail server that speaks a line protocol (IMAP, SMTP). Every method throws {@see CheckFailed} when
 * the connection breaks or the time for the check runs out.
 */
interface LineConnection
{
    /** The next line the server sent, without its line ending. */
    public function readLine(): string;

    /** Sends data as is; the caller adds the line ending. */
    public function write(#[\SensitiveParameter] string $data): void;

    /** Upgrades the connection to TLS and verifies the server's certificate for its host name. */
    public function startTls(): void;

    public function close(): void;
}
