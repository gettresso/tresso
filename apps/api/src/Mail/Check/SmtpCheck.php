<?php

declare(strict_types=1);

namespace App\Mail\Check;

/**
 * Signs in to an SMTP server the way the sync workers send mail (EHLO, STARTTLS where asked for, AUTH PLAIN or
 * LOGIN) and leaves without sending anything.
 */
final class SmtpCheck
{
    public function __construct(private readonly LineConnection $connection, private readonly string $host)
    {
    }

    /**
     * @throws CheckFailed
     */
    public function run(bool $startTls, string $username, #[\SensitiveParameter] string $password): void
    {
        [$code, $text] = $this->reply();
        if (220 !== $code) {
            throw new CheckFailed(CheckStatus::Failed, \sprintf('%s did not greet like a mail server. %s', $this->host, self::said($code, $text)));
        }

        $extensions = $this->hello();
        if ($startTls) {
            $this->connection->write("STARTTLS\r\n");
            [$code, $text] = $this->reply();
            if (220 !== $code) {
                throw new CheckFailed(CheckStatus::Failed, 'The server does not offer STARTTLS. '.self::said($code, $text));
            }
            $this->connection->startTls();
            $extensions = $this->hello();
        }

        $mechanisms = null;
        foreach ($extensions as $extension) {
            if (1 === preg_match('/^AUTH[ =](.*)$/i', $extension, $match)) {
                $mechanisms = array_map('strtoupper', preg_split('/\s+/', trim($match[1])) ?: []);
            }
        }
        // A server that asks for no sign-in; sending may still work, as the workers accept too.
        if (null !== $mechanisms) {
            $this->authenticate($mechanisms, $username, $password);
        }

        try {
            $this->connection->write("QUIT\r\n");
        } catch (CheckFailed) {
        }
    }

    /**
     * @param list<string> $mechanisms
     */
    private function authenticate(array $mechanisms, string $username, #[\SensitiveParameter] string $password): void
    {
        if (\in_array('PLAIN', $mechanisms, true)) {
            $this->connection->write('AUTH PLAIN '.base64_encode("\0".$username."\0".$password)."\r\n");
            [$code, $text] = $this->reply();
        } elseif (\in_array('LOGIN', $mechanisms, true)) {
            $this->connection->write("AUTH LOGIN\r\n");
            [$code, $text] = $this->reply();
            if (334 === $code) {
                $this->connection->write(base64_encode($username)."\r\n");
                [$code, $text] = $this->reply();
            }
            if (334 === $code) {
                $this->connection->write(base64_encode($password)."\r\n");
                [$code, $text] = $this->reply();
            }
        } else {
            throw new CheckFailed(CheckStatus::Failed, 'The outgoing mail server offers no sign-in method Tresso supports.');
        }

        if (235 === $code) {
            return;
        }
        // 454 is a temporary failure at the server (RFC 4954), not a wrong password.
        if (535 === $code || 534 === $code) {
            throw new CheckFailed(CheckStatus::AuthFailed, self::said($code, $text));
        }

        throw new CheckFailed(CheckStatus::Failed, 'Signing in to the outgoing mail server failed. '.self::said($code, $text));
    }

    /**
     * @return list<string> the extensions the server lists
     */
    private function hello(): array
    {
        $this->connection->write("EHLO localhost\r\n");
        [$code, $text, $lines] = $this->reply();
        if (250 !== $code) {
            throw new CheckFailed(CheckStatus::Failed, 'The outgoing mail server did not accept the connection. '.self::said($code, $text));
        }

        return \array_slice($lines, 1);
    }

    /**
     * Reads one reply, also one over several lines.
     *
     * @return array{int, string, list<string>}
     */
    private function reply(): array
    {
        $lines = [];
        while (true) {
            $line = $this->connection->readLine();
            if (1 !== preg_match('/^(\d{3})([ -])(.*)$/', $line, $match) && 1 !== preg_match('/^(\d{3})()()$/', $line, $match)) {
                throw new CheckFailed(CheckStatus::Failed, \sprintf('%s did not answer like a mail server.', $this->host));
            }
            $lines[] = $match[3];
            if ('-' !== $match[2]) {
                return [(int) $match[1], implode(' ', $lines), $lines];
            }
        }
    }

    private static function said(int $code, string $text): string
    {
        return trim(\sprintf('The server said: %d %s', $code, mb_strimwidth(trim($text), 0, 200, '...')));
    }
}
