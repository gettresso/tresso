<?php

declare(strict_types=1);

namespace App\Mail\Check;

/**
 * A TCP connection to a mail server, with one deadline for everything done on it.
 */
final class SocketConnection implements LineConnection
{
    /** Longer lines are cut off; no mail server answer a check reads is anywhere near this. */
    private const int MAX_LINE = 8192;

    /**
     * @param resource $stream
     */
    public function __construct(
        private $stream,
        private readonly string $host,
        private readonly int $port,
        private readonly float $deadline,
        private readonly int $timeoutSeconds,
    ) {
    }

    public function readLine(): string
    {
        $this->applyTimeout();
        $line = fgets($this->stream, self::MAX_LINE);
        if (false === $line) {
            throw $this->broken();
        }

        return rtrim($line, "\r\n");
    }

    public function write(#[\SensitiveParameter] string $data): void
    {
        $this->applyTimeout();
        $written = 0;
        while ($written < \strlen($data)) {
            $sent = fwrite($this->stream, substr($data, $written));
            if (false === $sent || 0 === $sent) {
                throw $this->broken();
            }
            $written += $sent;
        }
    }

    public function startTls(): void
    {
        $this->applyTimeout();
        stream_context_set_options($this->stream, ['ssl' => self::tlsOptions($this->host)]);
        error_clear_last();
        // The warning says why the handshake failed; it is read below instead of being printed.
        $enabled = @stream_socket_enable_crypto($this->stream, true, \STREAM_CRYPTO_METHOD_TLSv1_2_CLIENT | \STREAM_CRYPTO_METHOD_TLSv1_3_CLIENT);
        if (true === $enabled) {
            return;
        }
        if ($this->timedOut()) {
            throw $this->broken();
        }
        $error = error_get_last()['message'] ?? '';
        if (str_contains($error, 'certificate') || str_contains($error, 'peer')) {
            throw new CheckFailed(CheckStatus::Certificate, \sprintf('The security certificate of %s could not be verified.', $this->host));
        }

        throw new CheckFailed(CheckStatus::Failed, \sprintf('A secure connection to %s could not be set up.', $this->address()));
    }

    public function close(): void
    {
        if (\is_resource($this->stream)) {
            fclose($this->stream);
        }
    }

    /**
     * What TLS checks: the certificate must be valid for the host name the user entered, whatever address the
     * connection went to.
     *
     * @return array<string, mixed>
     */
    public static function tlsOptions(string $host): array
    {
        return [
            'peer_name' => $host,
            'SNI_enabled' => true,
            'verify_peer' => true,
            'verify_peer_name' => true,
            'allow_self_signed' => false,
            'capture_peer_cert' => false,
        ];
    }

    private function applyTimeout(): void
    {
        $left = $this->deadline - microtime(true);
        if ($left <= 0) {
            throw $this->noAnswer();
        }
        stream_set_timeout($this->stream, (int) $left, (int) (($left - (int) $left) * 1_000_000));
    }

    private function timedOut(): bool
    {
        $meta = stream_get_meta_data($this->stream);

        return $meta['timed_out'] || microtime(true) >= $this->deadline;
    }

    private function broken(): CheckFailed
    {
        if ($this->timedOut()) {
            return $this->noAnswer();
        }

        return new CheckFailed(CheckStatus::Unreachable, \sprintf('The connection was closed (%s).', $this->address()));
    }

    private function noAnswer(): CheckFailed
    {
        return new CheckFailed(CheckStatus::Unreachable, \sprintf('No answer after %d seconds (%s).', $this->timeoutSeconds, $this->address()));
    }

    private function address(): string
    {
        return $this->host.':'.$this->port;
    }
}
