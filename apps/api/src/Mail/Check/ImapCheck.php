<?php

declare(strict_types=1);

namespace App\Mail\Check;

/**
 * Signs in to an IMAP server the way the sync workers do (LOGIN, after STARTTLS where asked for) and counts the
 * folders. Reads only: nothing on the server changes.
 */
final class ImapCheck
{
    /** Folders counted at most; a mailbox with more still passes. */
    private const int MAX_FOLDERS = 10_000;

    private int $tag = 0;

    public function __construct(private readonly LineConnection $connection, private readonly string $host)
    {
    }

    /**
     * @return int the number of folders
     *
     * @throws CheckFailed
     */
    public function run(bool $startTls, string $username, #[\SensitiveParameter] string $password): int
    {
        $greeting = $this->connection->readLine();
        if (!preg_match('/^\* (OK|PREAUTH)\b/i', $greeting)) {
            throw new CheckFailed(CheckStatus::Failed, \sprintf('%s did not greet like an IMAP server.', $this->host));
        }

        if ($startTls) {
            $this->command('STARTTLS', 'The server does not offer STARTTLS.');
            $this->connection->startTls();
        }

        $tag = $this->nextTag();
        $this->send($tag, ['LOGIN', $username, $password]);
        [$status, $text] = $this->response($tag);
        if ('OK' !== $status) {
            throw new CheckFailed(CheckStatus::AuthFailed, self::said($text) ?: 'The server did not accept the username or password.');
        }

        $folders = 0;
        $tag = $this->nextTag();
        $this->connection->write($tag." LIST \"\" \"*\"\r\n");
        while (true) {
            $line = $this->connection->readLine();
            if (str_starts_with($line, $tag.' ')) {
                [$status, $text] = self::status(substr($line, \strlen($tag) + 1));
                if ('OK' !== $status) {
                    throw new CheckFailed(CheckStatus::Failed, \sprintf('Listing the folders failed. %s', self::said($text)));
                }
                break;
            }
            if (1 === preg_match('/^\* LIST\b/i', $line) && $folders < self::MAX_FOLDERS) {
                ++$folders;
            }
        }

        // A polite goodbye; the answer does not matter any more.
        try {
            $this->connection->write($this->nextTag()." LOGOUT\r\n");
        } catch (CheckFailed) {
        }

        return $folders;
    }

    /**
     * Sends a command without arguments and expects OK.
     */
    private function command(string $command, string $refused): void
    {
        $tag = $this->nextTag();
        $this->connection->write($tag.' '.$command."\r\n");
        [$status, $text] = $this->response($tag);
        if ('OK' !== $status) {
            throw new CheckFailed(CheckStatus::Failed, $refused.' '.self::said($text));
        }
    }

    /**
     * Sends a command with arguments: quoted strings where possible, literals for anything else (non-ASCII, line
     * breaks), waiting for the server's go-ahead before each literal.
     *
     * @param list<string> $parts the command, then its arguments
     */
    private function send(string $tag, #[\SensitiveParameter] array $parts): void
    {
        $line = $tag.' '.array_shift($parts);
        foreach ($parts as $argument) {
            if (1 === preg_match('/^[\x20-\x7e]*$/', $argument)) {
                $line .= ' "'.addcslashes($argument, '"\\').'"';
                continue;
            }
            $this->connection->write($line.' {'.\strlen($argument)."}\r\n");
            $continuation = $this->connection->readLine();
            if (!str_starts_with($continuation, '+')) {
                [, $text] = self::status(substr($continuation, \strlen($tag) + 1));
                throw new CheckFailed(CheckStatus::AuthFailed, self::said($text) ?: 'The server did not accept the username or password.');
            }
            $line = $argument;
        }
        $this->connection->write($line."\r\n");
    }

    /**
     * Reads until the tagged response and returns its status (OK, NO, BAD) and text; untagged lines are skipped.
     *
     * @return array{string, string}
     */
    private function response(string $tag): array
    {
        while (true) {
            $line = $this->connection->readLine();
            if (str_starts_with($line, $tag.' ')) {
                return self::status(substr($line, \strlen($tag) + 1));
            }
            if (1 === preg_match('/^\* BYE\b/i', $line)) {
                throw new CheckFailed(CheckStatus::Failed, \sprintf('%s closed the connection. %s', $this->host, self::said(substr($line, 6))));
            }
        }
    }

    /**
     * @return array{string, string}
     */
    private static function status(string $rest): array
    {
        $parts = explode(' ', $rest, 2);

        return [strtoupper($parts[0]), trim($parts[1] ?? '')];
    }

    private static function said(string $text): string
    {
        $text = trim($text);

        return '' === $text ? '' : 'The server said: '.mb_strimwidth($text, 0, 200, '...');
    }

    private function nextTag(): string
    {
        return 't'.++$this->tag;
    }
}
