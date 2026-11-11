<?php

declare(strict_types=1);

namespace App\Mail\Check;

use App\Enum\ConnectionSecurity;
use App\Mail\ServerSettings;
use Psr\Log\LoggerInterface;

/**
 * Checks that Tresso can sign in to a mail account before the account is created: IMAP sign-in and the folder list,
 * then SMTP sign-in, each within {@see self::TIMEOUT} seconds and both together within {@see self::TOTAL} seconds.
 * Outgoing mail is only checked once incoming mail works, so a wrong password is reported once. Credentials are used
 * for this check only and never stored here.
 */
class MailConnectionChecker
{
    public const int TIMEOUT = 15;
    public const int TOTAL = 25;

    public function __construct(
        private readonly MailServerDialer $dialer,
        private readonly LoggerInterface $logger,
    ) {
    }

    public function check(ServerSettings $imap, ServerSettings $smtp, string $username, #[\SensitiveParameter] string $password): ConnectionCheck
    {
        $end = microtime(true) + self::TOTAL;
        try {
            $folders = $this->withConnection($imap, $end, static fn (LineConnection $connection): int => new ImapCheck($connection, $imap->host)->run(ConnectionSecurity::StartTls === $imap->security, $username, $password));
        } catch (CheckFailed $e) {
            $this->logger->info('Checking an IMAP server failed.', ['host' => $imap->host, 'port' => $imap->port, 'status' => $e->status->value]);

            return new ConnectionCheck($e->status, CheckStatus::NotChecked, null, $e->getMessage());
        }

        try {
            $this->withConnection($smtp, $end, static function (LineConnection $connection) use ($smtp, $username, $password): null {
                new SmtpCheck($connection, $smtp->host)->run(ConnectionSecurity::StartTls === $smtp->security, $username, $password);

                return null;
            });
        } catch (CheckFailed $e) {
            $this->logger->info('Checking an SMTP server failed.', ['host' => $smtp->host, 'port' => $smtp->port, 'status' => $e->status->value]);

            return new ConnectionCheck(CheckStatus::Ok, $e->status, $folders, $e->getMessage());
        }

        return new ConnectionCheck(CheckStatus::Ok, CheckStatus::Ok, $folders, null);
    }

    /**
     * @template T
     *
     * @param \Closure(LineConnection): T $use
     *
     * @return T
     */
    private function withConnection(ServerSettings $server, float $end, \Closure $use): mixed
    {
        $now = microtime(true);
        $deadline = min($now + self::TIMEOUT, $end);
        $connection = $this->dialer->connect($server, $deadline, max(1, (int) round($deadline - $now)));
        try {
            return $use($connection);
        } finally {
            $connection->close();
        }
    }
}
