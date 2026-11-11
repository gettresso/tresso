<?php

declare(strict_types=1);

namespace App\Mail\Check;

use App\Enum\ConnectionSecurity;
use App\Mail\HostResolver;
use App\Mail\ServerSettings;
use App\Validator\SafeMailServerValidator;
use Symfony\Component\DependencyInjection\Attribute\Autowire;

/**
 * Opens connections to mail servers for a check, with the rules the sync workers' dialer (apps/sync netguard)
 * applies: the host must resolve to public addresses only, and the connection goes to one of the addresses that
 * were checked, so a DNS answer that changes in between cannot point it at an internal service. TLS is verified
 * against the host name the user entered.
 */
class MailServerDialer
{
    /** Ranges the sync workers refuse too and PHP's filter does not call private or reserved. */
    private const array BLOCKED = [
        ['192.0.0.0', 24],
        ['192.0.2.0', 24],
        ['198.18.0.0', 15],
        ['198.51.100.0', 24],
        ['203.0.113.0', 24],
        ['224.0.0.0', 4],
        ['240.0.0.0', 4],
        ['64:ff9b::', 96],
        ['64:ff9b:1::', 48],
        ['2001:db8::', 32],
        ['2002::', 16],
        ['ff00::', 8],
    ];

    public function __construct(
        private readonly HostResolver $resolver,
        #[Autowire(env: 'bool:MAIL_ALLOW_UNSAFE_SERVERS')]
        private readonly bool $allowUnsafe,
    ) {
    }

    /**
     * Connects and, for TLS, finishes the handshake; STARTTLS is the protocol's part.
     *
     * @param float $deadline microtime(true) by which the whole check of this server must be done
     *
     * @throws CheckFailed
     */
    public function connect(ServerSettings $server, float $deadline, int $timeoutSeconds): LineConnection
    {
        $addresses = $this->resolver->resolve($server->host);
        if ([] === $addresses) {
            throw new CheckFailed(CheckStatus::Unreachable, \sprintf('The server name %s could not be found.', $server->host));
        }
        if (!$this->allowUnsafe) {
            if (ConnectionSecurity::None === $server->security) {
                throw new CheckFailed(CheckStatus::Blocked, 'Unencrypted connections are not allowed.');
            }
            foreach ($addresses as $address) {
                if (!self::isPublic($address)) {
                    throw new CheckFailed(CheckStatus::Blocked, \sprintf('%s resolves to a private or reserved address.', $server->host));
                }
            }
        }

        $failure = null;
        foreach ($addresses as $address) {
            $left = $deadline - microtime(true);
            if ($left <= 0) {
                break;
            }
            $target = str_contains($address, ':') ? '['.$address.']' : $address;
            $errorCode = 0;
            $errorMessage = '';
            $stream = @stream_socket_client(
                'tcp://'.$target.':'.$server->port,
                $errorCode,
                $errorMessage,
                $left,
                \STREAM_CLIENT_CONNECT,
                stream_context_create(['ssl' => SocketConnection::tlsOptions($server->host)]),
            );
            if (false === $stream) {
                $failure = '' !== $errorMessage ? $errorMessage : 'no answer';
                continue;
            }

            $connection = new SocketConnection($stream, $server->host, $server->port, $deadline, $timeoutSeconds);
            if (ConnectionSecurity::Tls === $server->security) {
                try {
                    $connection->startTls();
                } catch (CheckFailed $e) {
                    $connection->close();

                    throw $e;
                }
            }

            return $connection;
        }

        if (null === $failure || microtime(true) >= $deadline || str_contains(strtolower($failure), 'timed out')) {
            throw new CheckFailed(CheckStatus::Unreachable, \sprintf('No answer after %d seconds (%s:%d).', $timeoutSeconds, $server->host, $server->port));
        }

        throw new CheckFailed(CheckStatus::Unreachable, \sprintf('%s (%s:%d).', ucfirst(rtrim($failure, '.')), $server->host, $server->port));
    }

    /**
     * Whether a mail server may live at this address; the same ranges as the sync workers' netguard.IsPublic.
     */
    public static function isPublic(string $address): bool
    {
        $mapped = self::mappedIpv4($address);
        if (null !== $mapped) {
            $address = $mapped;
        }
        if (!SafeMailServerValidator::isPublic($address)) {
            return false;
        }
        foreach (self::BLOCKED as [$network, $bits]) {
            if (self::inNetwork($address, $network, $bits)) {
                return false;
            }
        }

        return true;
    }

    /** The IPv4 address inside an IPv4-mapped IPv6 address (::ffff:a.b.c.d), as the workers unmap it. */
    private static function mappedIpv4(string $address): ?string
    {
        $packed = @inet_pton($address);
        if (false === $packed || 16 !== \strlen($packed) || !str_starts_with($packed, str_repeat("\0", 10)."\xff\xff")) {
            return null;
        }
        $ipv4 = inet_ntop(substr($packed, 12));

        return false === $ipv4 ? null : $ipv4;
    }

    private static function inNetwork(string $address, string $network, int $bits): bool
    {
        $packed = @inet_pton($address);
        $base = @inet_pton($network);
        if (false === $packed || false === $base || \strlen($packed) !== \strlen($base)) {
            return false;
        }
        $bytes = intdiv($bits, 8);
        if (substr($packed, 0, $bytes) !== substr($base, 0, $bytes)) {
            return false;
        }
        $rest = $bits % 8;
        if (0 === $rest) {
            return true;
        }
        $mask = (0xFF << (8 - $rest)) & 0xFF;

        return (\ord($packed[$bytes]) & $mask) === (\ord($base[$bytes]) & $mask);
    }
}
