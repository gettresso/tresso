<?php

declare(strict_types=1);

namespace App\Mail\Check;

/**
 * A TCP connection to a mail server with one deadline for everything done on it. The stream is non-blocking and every
 * wait goes through stream_select() against that deadline, so a server that sends a byte now and then cannot hold a
 * check longer than the deadline (a stream timeout would only bound each single read).
 */
final class SocketConnection implements LineConnection
{
    /** Longer lines are refused; no mail server answer a check reads is anywhere near this. */
    private const int MAX_LINE = 8192;

    private string $buffer = '';

    /**
     * @param resource $stream
     */
    public function __construct(
        private $stream,
        private readonly string $host,
        private readonly int $port,
        private readonly float $deadline,
        private readonly int $timeoutSeconds,
        private readonly ?string $caFile = null,
    ) {
        stream_set_blocking($this->stream, false);
    }

    public function readLine(): string
    {
        while (true) {
            $end = strpos($this->buffer, "\n");
            if (false !== $end) {
                $line = substr($this->buffer, 0, $end);
                $this->buffer = substr($this->buffer, $end + 1);

                return rtrim($line, "\r");
            }
            if (\strlen($this->buffer) > self::MAX_LINE) {
                throw new CheckFailed(CheckStatus::Failed, \sprintf('%s sent a line longer than a mail server would.', $this->host));
            }
            // Data TLS already decrypted is not seen by stream_select(), so read before waiting.
            $chunk = fread($this->stream, self::MAX_LINE);
            if (false === $chunk) {
                throw $this->closed();
            }
            if ('' !== $chunk) {
                $this->buffer .= $chunk;
                continue;
            }
            if (feof($this->stream)) {
                throw $this->closed();
            }
            $this->wait(read: true);
        }
    }

    public function write(#[\SensitiveParameter] string $data): void
    {
        while ('' !== $data) {
            $sent = fwrite($this->stream, $data);
            if (false === $sent) {
                throw $this->closed();
            }
            $data = substr($data, $sent);
            if ('' !== $data) {
                $this->wait(read: false);
            }
        }
    }

    public function startTls(): void
    {
        stream_context_set_options($this->stream, ['ssl' => self::tlsOptions($this->host, $this->caFile)]);
        while (true) {
            error_clear_last();
            // The warning says why the handshake failed; it is read below instead of being printed.
            $done = @stream_socket_enable_crypto($this->stream, true, \STREAM_CRYPTO_METHOD_TLSv1_2_CLIENT | \STREAM_CRYPTO_METHOD_TLSv1_3_CLIENT);
            if (true === $done) {
                return;
            }
            if (0 === $done) {
                // Non-blocking: the handshake needs more from the server.
                $this->wait(read: true);
                continue;
            }
            $error = error_get_last()['message'] ?? '';
            if (str_contains($error, 'certificate') || str_contains($error, 'peer')) {
                throw new CheckFailed(CheckStatus::Certificate, \sprintf('The security certificate of %s could not be verified.', $this->host));
            }

            throw new CheckFailed(CheckStatus::Failed, \sprintf('A secure connection to %s could not be set up.', $this->address()));
        }
    }

    public function close(): void
    {
        if (\is_resource($this->stream)) {
            fclose($this->stream);
        }
    }

    /**
     * What TLS checks: the certificate must be valid for the host name the user entered, whatever address the
     * connection went to. $caFile replaces the system's certificate authorities (tests only).
     *
     * @return array<string, mixed>
     */
    public static function tlsOptions(string $host, ?string $caFile = null): array
    {
        $options = [
            'peer_name' => $host,
            'SNI_enabled' => true,
            'verify_peer' => true,
            'verify_peer_name' => true,
            'allow_self_signed' => false,
            'capture_peer_cert' => false,
        ];
        if (null !== $caFile) {
            $options['cafile'] = $caFile;
        }

        return $options;
    }

    /**
     * Waits until the stream can be read (or written), or throws when the deadline passed first.
     */
    private function wait(bool $read): void
    {
        $left = $this->deadline - microtime(true);
        if ($left <= 0) {
            throw $this->noAnswer();
        }
        $readable = $read ? [$this->stream] : [];
        $writable = $read ? [] : [$this->stream];
        $except = null;
        $ready = @stream_select($readable, $writable, $except, (int) $left, (int) (($left - (int) $left) * 1_000_000));
        if (false === $ready) {
            throw $this->closed();
        }
        if (0 === $ready) {
            throw $this->noAnswer();
        }
    }

    private function closed(): CheckFailed
    {
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
