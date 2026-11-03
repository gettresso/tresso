<?php

declare(strict_types=1);

namespace App\Security\OAuth;

use Symfony\Component\DependencyInjection\Attribute\Autowire;
use Symfony\Component\RateLimiter\RateLimit;
use Symfony\Component\RateLimiter\RateLimiterFactoryInterface;

/**
 * How many clients may register: per sender, per IPv6 network and in total. A sender is an IPv4 address (also when it
 * arrives as an IPv4-mapped IPv6 address, `::ffff:a.b.c.d`) or an IPv6 /64, since one network usually gets a whole
 * /64; a /48 is what one site usually gets, so it has a limit of its own.
 */
final readonly class RegistrationLimits
{
    public function __construct(
        #[Autowire(service: 'limiter.oauth_client_registration')]
        private RateLimiterFactoryInterface $perSender,
        #[Autowire(service: 'limiter.oauth_client_registration_network')]
        private RateLimiterFactoryInterface $perNetwork,
        #[Autowire(service: 'limiter.oauth_client_registration_global')]
        private RateLimiterFactoryInterface $total,
    ) {
    }

    /** Counts one registration; returns the limit that refused it, or null when it may go ahead. */
    public function consume(?string $ip): ?RateLimit
    {
        foreach ($this->limiters($ip) as $limiter) {
            $limit = $limiter->consume();
            if (!$limit->isAccepted()) {
                return $limit;
            }
        }

        return null;
    }

    /** Forgets what was counted for these addresses and in total. */
    public function reset(?string ...$ips): void
    {
        foreach ($ips as $ip) {
            foreach ($this->limiters($ip) as $limiter) {
                $limiter->reset();
            }
        }
    }

    /**
     * The sender: an IPv4 address or an IPv6 /64.
     */
    public static function senderKey(?string $ip): string
    {
        $address = self::parse($ip);

        return match (true) {
            null === $address => $ip ?? 'unknown',
            4 === \strlen($address) => (string) inet_ntop($address),
            default => self::prefix($address, 8).'/64',
        };
    }

    /** The IPv6 /48 of the sender, or null for IPv4. */
    public static function networkKey(?string $ip): ?string
    {
        $address = self::parse($ip);

        return null === $address || 4 === \strlen($address) ? null : self::prefix($address, 6).'/48';
    }

    /** @return list<\Symfony\Component\RateLimiter\LimiterInterface> */
    private function limiters(?string $ip): array
    {
        $limiters = [$this->perSender->create(self::senderKey($ip))];
        $network = self::networkKey($ip);
        if (null !== $network) {
            $limiters[] = $this->perNetwork->create($network);
        }
        $limiters[] = $this->total->create('all');

        return $limiters;
    }

    /** The packed address: 4 bytes for IPv4 (also IPv4-mapped IPv6), 16 for IPv6; null when it is no IP address. */
    private static function parse(?string $ip): ?string
    {
        if (null === $ip || false === filter_var($ip, \FILTER_VALIDATE_IP)) {
            return null;
        }
        $packed = inet_pton($ip);
        if (false === $packed) {
            return null;
        }
        if (16 === \strlen($packed) && str_starts_with($packed, str_repeat("\0", 10)."\xff\xff")) {
            return substr($packed, 12);
        }

        return $packed;
    }

    private static function prefix(string $packed, int $bytes): string
    {
        return (string) inet_ntop(substr($packed, 0, $bytes).str_repeat("\0", 16 - $bytes));
    }
}
