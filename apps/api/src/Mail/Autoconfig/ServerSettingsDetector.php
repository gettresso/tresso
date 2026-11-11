<?php

declare(strict_types=1);

namespace App\Mail\Autoconfig;

use Psr\Log\LoggerInterface;
use Symfony\Component\DependencyInjection\Attribute\Autowire;
use Symfony\Contracts\Cache\CacheInterface;
use Symfony\Contracts\Cache\ItemInterface;
use Symfony\Contracts\HttpClient\Exception\ExceptionInterface;
use Symfony\Contracts\HttpClient\HttpClientInterface;
use Symfony\Contracts\HttpClient\ResponseInterface;

/**
 * Finds the IMAP and SMTP servers for an address the way Thunderbird does: the provider's own autoconfig, then
 * Mozilla's ISPDB by domain, then ISPDB by the domain's mail exchanger (which finds hosted mail, e.g. a company
 * domain on a large provider). Requests go through a client that refuses private networks, because the domain is
 * user input. Also tells which large provider handles an address ({@see self::provider()}), so the client can offer
 * the easiest way to connect it.
 *
 * Answers are cached per domain, so they must not depend on the address: the address is not sent to the domain's own
 * autoconfig (a server that personalized its answer would otherwise hand one user's login name to the next).
 */
final readonly class ServerSettingsDetector
{
    public const string ISPDB_URL = 'https://autoconfig.thunderbird.net/v1.1/';
    private const int FOUND_TTL = 86_400;
    private const int MISSING_TTL = 3_600;
    private const int MAX_BYTES = 65_536;
    private const int MX_LOOKUPS = 3;

    public function __construct(
        #[Autowire(service: 'mail_autoconfig.http_client')]
        private HttpClientInterface $httpClient,
        #[Autowire(service: 'cache.mail_autoconfig')]
        private CacheInterface $cache,
        private AutoconfigParser $parser,
        private MxResolver $mx,
        private LoggerInterface $logger,
    ) {
    }

    public function detect(string $emailAddress): ?DetectedServers
    {
        $domain = self::domainOf($emailAddress);
        if (null === $domain) {
            return null;
        }

        /** @var array{xml: string, source: string}|null $found */
        $found = $this->cache->get('autoconfig.'.hash('sha256', $domain), function (ItemInterface $item) use ($domain, $emailAddress): ?array {
            $found = $this->lookup($domain, $emailAddress);
            $item->expiresAfter(null === $found ? self::MISSING_TTL : self::FOUND_TTL);

            return $found;
        });

        return null === $found ? null : $this->parser->parse($found['xml'], $emailAddress)?->from($found['source']);
    }

    /**
     * Which large provider handles mail for the address: by its domain (gmail.com, outlook.com, icloud.com, yahoo.*),
     * otherwise by the domain's preferred mail exchanger, which finds company domains on Google Workspace or
     * Microsoft 365. Null for everything else.
     */
    public function provider(string $emailAddress): ?MailServiceProvider
    {
        $domain = self::domainOf($emailAddress);
        if (null === $domain) {
            return null;
        }

        $byDomain = MailServiceProvider::forDomain($domain);
        if (null !== $byDomain) {
            return $byDomain;
        }
        $exchanger = $this->exchangers($domain)[0] ?? null;

        return null === $exchanger ? null : MailServiceProvider::forMailExchanger($exchanger);
    }

    private static function domainOf(string $emailAddress): ?string
    {
        $domain = strtolower(substr((string) strrchr($emailAddress, '@'), 1));

        return 1 === preg_match('/^(?=.{1,253}$)([a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.)+[a-z]{2,63}$/', $domain) ? $domain : null;
    }

    /**
     * The domain's mail exchangers, most preferred first; cached like the settings, since both the settings lookup and
     * {@see self::provider()} ask.
     *
     * @return list<string>
     */
    private function exchangers(string $domain): array
    {
        /** @var list<string> $exchangers */
        $exchangers = $this->cache->get('mx.'.hash('sha256', $domain), function (ItemInterface $item) use ($domain): array {
            $exchangers = $this->mx->resolve($domain);
            $item->expiresAfter([] === $exchangers ? self::MISSING_TTL : self::FOUND_TTL);

            return $exchangers;
        });

        return $exchangers;
    }

    /**
     * @return array{xml: string, source: string}|null
     */
    private function lookup(string $domain, string $emailAddress): ?array
    {
        // Started together, used in order of preference. Without the address: the answer is cached for the domain.
        $requests = [
            'provider' => $this->get('https://autoconfig.'.$domain.'/mail/config-v1.1.xml'),
            'provider-well-known' => $this->get('https://'.$domain.'/.well-known/autoconfig/mail/config-v1.1.xml'),
            'ispdb' => $this->get(self::ISPDB_URL.$domain),
        ];
        try {
            foreach ($requests as $source => $response) {
                $xml = $this->body($response);
                if (null !== $xml && null !== $this->parser->parse($xml, $emailAddress)) {
                    return ['xml' => $xml, 'source' => $source];
                }
            }
        } finally {
            // Responses that are not needed any more are dropped, not read.
            foreach ($requests as $response) {
                $response?->cancel();
            }
        }

        foreach ($this->mxDomains($domain) as $mxDomain) {
            $xml = $this->body($this->get(self::ISPDB_URL.$mxDomain));
            if (null !== $xml && null !== $this->parser->parse($xml, $emailAddress)) {
                return ['xml' => $xml, 'source' => 'ispdb-mx'];
            }
        }

        return null;
    }

    /**
     * Parent domains of the preferred mail exchanger, most specific first and never a bare TLD:
     * aspmx.l.google.com gives l.google.com, google.com.
     *
     * @return list<string>
     */
    private function mxDomains(string $domain): array
    {
        $exchanger = $this->exchangers($domain)[0] ?? null;
        if (null === $exchanger) {
            return [];
        }
        $labels = explode('.', $exchanger);
        $domains = [];
        for ($i = 1; \count($labels) - $i >= 2 && \count($domains) < self::MX_LOOKUPS; ++$i) {
            $candidate = implode('.', \array_slice($labels, $i));
            if ($candidate !== $domain) {
                $domains[] = $candidate;
            }
        }

        return $domains;
    }

    private function get(string $url): ?ResponseInterface
    {
        try {
            return $this->httpClient->request('GET', $url, ['timeout' => 4, 'max_duration' => 6, 'max_redirects' => 2]);
        } catch (ExceptionInterface $exception) {
            $this->logger->info('Autoconfig request could not be made.', ['url' => $url, 'exception' => $exception]);

            return null;
        }
    }

    private function body(?ResponseInterface $response): ?string
    {
        if (null === $response) {
            return null;
        }
        try {
            if (200 !== $response->getStatusCode()) {
                $response->cancel();

                return null;
            }
            $body = '';
            foreach ($this->httpClient->stream($response) as $chunk) {
                $body .= $chunk->getContent();
                if (\strlen($body) > self::MAX_BYTES) {
                    $response->cancel();

                    return null;
                }
            }

            return $body;
        } catch (ExceptionInterface $exception) {
            $this->logger->info('Autoconfig lookup failed.', ['url' => $response->getInfo('url'), 'exception' => $exception]);

            return null;
        }
    }
}
