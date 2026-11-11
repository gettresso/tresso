<?php

declare(strict_types=1);

namespace App\Tests\Unit\Mail\Check;

use App\Enum\ConnectionSecurity;
use App\Mail\Check\CheckFailed;
use App\Mail\Check\CheckStatus;
use App\Mail\Check\MailServerDialer;
use App\Mail\HostResolver;
use App\Mail\ServerSettings;
use PHPUnit\Framework\Attributes\DataProvider;
use PHPUnit\Framework\TestCase;

final class MailServerDialerTest extends TestCase
{
    /**
     * The same cases as the sync workers' netguard test, so both refuse the same addresses.
     *
     * @return iterable<string, array{string, bool}>
     */
    public static function addresses(): iterable
    {
        yield 'public IPv4' => ['93.184.216.34', true];
        yield 'public IPv6' => ['2606:2800:220:1::1', true];
        yield 'private 10/8' => ['10.0.0.1', false];
        yield 'private 172.16/12' => ['172.16.5.4', false];
        yield 'private 192.168/16' => ['192.168.1.1', false];
        yield 'loopback' => ['127.0.0.1', false];
        yield 'cloud metadata' => ['169.254.169.254', false];
        yield 'carrier-grade NAT' => ['100.64.0.1', false];
        yield 'this network' => ['0.0.0.0', false];
        yield 'broadcast' => ['255.255.255.255', false];
        yield 'IPv6 loopback' => ['::1', false];
        yield 'unique local' => ['fd00::1', false];
        yield 'link-local' => ['fe80::1', false];
        yield 'mapped private' => ['::ffff:10.0.0.1', false];
        yield 'mapped public' => ['::ffff:93.184.216.34', true];
        yield 'NAT64' => ['64:ff9b::a00:1', false];
        yield '6to4' => ['2002:a00:1::1', false];
        yield 'multicast' => ['224.0.0.1', false];
        yield 'documentation' => ['192.0.2.5', false];
        yield 'benchmarking' => ['198.18.0.1', false];
    }

    #[DataProvider('addresses')]
    public function testRefusesTheAddressesTheWorkersRefuse(string $address, bool $public): void
    {
        self::assertSame($public, MailServerDialer::isPublic($address));
    }

    public function testRefusesAHostWithOnePrivateAddressWithoutConnecting(): void
    {
        $failure = $this->failure($this->dialer(['imap.example.test' => ['93.184.216.34', '10.0.0.5']]), new ServerSettings('imap.example.test', 993, ConnectionSecurity::Tls));

        self::assertSame(CheckStatus::Blocked, $failure->status);
    }

    public function testRefusesUnencryptedConnections(): void
    {
        $failure = $this->failure($this->dialer(['imap.example.test' => ['93.184.216.34']]), new ServerSettings('imap.example.test', 143, ConnectionSecurity::None));

        self::assertSame(CheckStatus::Blocked, $failure->status);
    }

    public function testAnUnknownHostIsUnreachable(): void
    {
        $failure = $this->failure($this->dialer([]), new ServerSettings('imap.unknown.test', 993, ConnectionSecurity::Tls));

        self::assertSame(CheckStatus::Unreachable, $failure->status);
        self::assertSame('The server name imap.unknown.test could not be found.', $failure->getMessage());
    }

    public function testAClosedPortIsUnreachableAndNamesHostAndPort(): void
    {
        $server = stream_socket_server('tcp://127.0.0.1:0');
        self::assertIsResource($server);
        $port = (int) substr((string) strrchr((string) stream_socket_get_name($server, false), ':'), 1);
        fclose($server);

        $failure = $this->failure($this->dialer(['imap.local.test' => ['127.0.0.1']], allowUnsafe: true), new ServerSettings('imap.local.test', $port, ConnectionSecurity::None));

        self::assertSame(CheckStatus::Unreachable, $failure->status);
        self::assertStringEndsWith('(imap.local.test:'.$port.').', $failure->getMessage());
    }

    /**
     * @param array<string, list<string>> $dns
     */
    private function dialer(array $dns, bool $allowUnsafe = false): MailServerDialer
    {
        $resolver = new class($dns) extends HostResolver {
            /** @param array<string, list<string>> $dns */
            public function __construct(private readonly array $dns)
            {
            }

            public function resolve(string $host): array
            {
                return $this->dns[$host] ?? [];
            }
        };

        return new MailServerDialer($resolver, $allowUnsafe);
    }

    private function failure(MailServerDialer $dialer, ServerSettings $server): CheckFailed
    {
        try {
            $dialer->connect($server, microtime(true) + 5, 5)->close();
        } catch (CheckFailed $e) {
            return $e;
        }
        self::fail('The connection was made.');
    }
}
