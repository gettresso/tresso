<?php

declare(strict_types=1);

namespace App\Tests\Unit\Mail\Check;

use App\Enum\ConnectionSecurity;
use App\Mail\Check\CheckFailed;
use App\Mail\Check\CheckStatus;
use App\Mail\Check\ImapCheck;
use App\Mail\Check\MailServerDialer;
use App\Mail\HostResolver;
use App\Mail\ServerSettings;
use PHPUnit\Framework\TestCase;
use Symfony\Component\Process\Process;

/**
 * TLS from the first byte and STARTTLS against a scripted IMAP server on this machine with a certificate made for the
 * test: signed in when the certificate is trusted and names the host, `certificate` when it is not trusted or names
 * another host.
 */
final class TlsCheckTest extends TestCase
{
    private const string HOST = 'mail.local.test';

    private static string $certificate = '';

    private ?Process $server = null;

    public static function setUpBeforeClass(): void
    {
        $key = openssl_pkey_new(['private_key_bits' => 2048, 'private_key_type' => \OPENSSL_KEYTYPE_RSA]);
        if (!$key instanceof \OpenSSLAsymmetricKey) {
            self::fail('No key: '.openssl_error_string());
        }
        // openssl_csr_new() takes the key by reference; the copy keeps $key's type.
        $csrKey = $key;
        $csr = openssl_csr_new(['commonName' => self::HOST], $csrKey, ['digest_alg' => 'sha256']);
        if (!$csr instanceof \OpenSSLCertificateSigningRequest) {
            self::fail('No signing request: '.openssl_error_string());
        }
        $certificate = openssl_csr_sign($csr, null, $key, 1, ['digest_alg' => 'sha256']);
        if (!$certificate instanceof \OpenSSLCertificate) {
            self::fail('No certificate: '.openssl_error_string());
        }
        $pem = '';
        $privateKey = '';
        self::assertTrue(openssl_x509_export($certificate, $pem));
        self::assertTrue(openssl_pkey_export($key, $privateKey));
        self::assertIsString($pem);
        self::assertIsString($privateKey);
        self::$certificate = (string) tempnam(sys_get_temp_dir(), 'tresso-check-cert');
        file_put_contents(self::$certificate, $pem.$privateKey);
    }

    public static function tearDownAfterClass(): void
    {
        @unlink(self::$certificate);
    }

    protected function tearDown(): void
    {
        $this->server?->stop(0);
    }

    public function testSignsInOverTls(): void
    {
        $port = $this->serve('tls');

        self::assertSame(3, $this->signIn(self::HOST, $port, ConnectionSecurity::Tls, self::$certificate));
    }

    public function testSignsInAfterStartTls(): void
    {
        $port = $this->serve('starttls');

        self::assertSame(3, $this->signIn(self::HOST, $port, ConnectionSecurity::StartTls, self::$certificate));
    }

    public function testACertificateNoAuthorityVouchesForIsRefused(): void
    {
        $port = $this->serve('tls');

        self::assertSame(CheckStatus::Certificate, $this->failure(self::HOST, $port, ConnectionSecurity::Tls, null)->status);
    }

    public function testACertificateForAnotherHostIsRefused(): void
    {
        $port = $this->serve('tls');

        $failure = $this->failure('other.local.test', $port, ConnectionSecurity::Tls, self::$certificate);

        self::assertSame(CheckStatus::Certificate, $failure->status);
        self::assertSame('The security certificate of other.local.test could not be verified.', $failure->getMessage());
    }

    public function testStartTlsWithAnUntrustedCertificateIsRefusedBeforeThePasswordIsSent(): void
    {
        $port = $this->serve('starttls');

        self::assertSame(CheckStatus::Certificate, $this->failure(self::HOST, $port, ConnectionSecurity::StartTls, null)->status);
    }

    private function serve(string $security): int
    {
        $this->server = new Process([\PHP_BINARY, __DIR__.'/../../../Support/bin/scripted-mail-server.php', 'secret', 'secret', $security, self::$certificate]);
        $this->server->start();
        $port = 0;
        $this->server->waitUntil(static function (string $type, string $output) use (&$port): bool {
            $port = (int) explode(' ', trim($output))[0];

            return Process::OUT === $type && $port > 0;
        });

        return $port;
    }

    private function signIn(string $host, int $port, ConnectionSecurity $security, ?string $caFile): int
    {
        $connection = $this->dialer($caFile)->connect(new ServerSettings($host, $port, $security), microtime(true) + 10, 10);
        try {
            return new ImapCheck($connection, $host)->run(ConnectionSecurity::StartTls === $security, 'kim', 'secret');
        } finally {
            $connection->close();
        }
    }

    private function failure(string $host, int $port, ConnectionSecurity $security, ?string $caFile): CheckFailed
    {
        try {
            $this->signIn($host, $port, $security, $caFile);
        } catch (CheckFailed $e) {
            return $e;
        }
        self::fail('Signed in.');
    }

    private function dialer(?string $caFile): MailServerDialer
    {
        $resolver = new class extends HostResolver {
            public function resolve(string $host): array
            {
                return ['127.0.0.1'];
            }
        };

        // Local addresses are allowed here, as in the test environment (MAIL_ALLOW_UNSAFE_SERVERS=1).
        return new MailServerDialer($resolver, true, $caFile);
    }
}
