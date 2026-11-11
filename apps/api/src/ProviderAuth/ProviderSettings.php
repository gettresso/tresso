<?php

declare(strict_types=1);

namespace App\ProviderAuth;

use App\Enum\OAuthProvider;
use Symfony\Component\DependencyInjection\Attribute\Autowire;

/**
 * The OAuth apps this installation registered at Google and Microsoft (docs/ARCHITECTURE.md lists the steps), and
 * the providers' endpoints. A provider without a client id is not offered.
 */
final readonly class ProviderSettings
{
    public function __construct(
        #[Autowire('%env(string:GOOGLE_OAUTH_CLIENT_ID)%')]
        private string $googleClientId,
        #[Autowire('%env(string:GOOGLE_OAUTH_CLIENT_SECRET)%')]
        private string $googleClientSecret,
        #[Autowire('%env(string:MICROSOFT_OAUTH_CLIENT_ID)%')]
        private string $microsoftClientId,
        #[Autowire('%env(string:MICROSOFT_OAUTH_CLIENT_SECRET)%')]
        private string $microsoftClientSecret,
        /** "common" (work, school and personal accounts), "organizations", "consumers" or one tenant id. */
        #[Autowire('%env(string:MICROSOFT_OAUTH_TENANT)%')]
        private string $microsoftTenant,
        /** Where browsers reach the API; the providers redirect back to <this>/connect/<provider>/callback. */
        #[Autowire('%env(string:API_PUBLIC_URL)%')]
        private string $apiPublicUrl,
    ) {
    }

    public function isConfigured(OAuthProvider $provider): bool
    {
        return '' !== $this->clientId($provider) && '' !== $this->clientSecret($provider);
    }

    /** @return list<OAuthProvider> */
    public function configuredProviders(): array
    {
        return array_values(array_filter(OAuthProvider::cases(), $this->isConfigured(...)));
    }

    public function clientId(OAuthProvider $provider): string
    {
        return match ($provider) {
            OAuthProvider::Google => $this->googleClientId,
            OAuthProvider::Microsoft => $this->microsoftClientId,
        };
    }

    public function clientSecret(OAuthProvider $provider): string
    {
        return match ($provider) {
            OAuthProvider::Google => $this->googleClientSecret,
            OAuthProvider::Microsoft => $this->microsoftClientSecret,
        };
    }

    public function redirectUri(OAuthProvider $provider): string
    {
        return rtrim($this->apiPublicUrl, '/').'/connect/'.$provider->value.'/callback';
    }

    public function authorizationEndpoint(OAuthProvider $provider): string
    {
        return match ($provider) {
            OAuthProvider::Google => 'https://accounts.google.com/o/oauth2/v2/auth',
            OAuthProvider::Microsoft => 'https://login.microsoftonline.com/'.rawurlencode($this->tenant()).'/oauth2/v2.0/authorize',
        };
    }

    public function tokenEndpoint(OAuthProvider $provider): string
    {
        return match ($provider) {
            OAuthProvider::Google => 'https://oauth2.googleapis.com/token',
            OAuthProvider::Microsoft => 'https://login.microsoftonline.com/'.rawurlencode($this->tenant()).'/oauth2/v2.0/token',
        };
    }

    /** Google revokes a refresh token on request; Microsoft has no such endpoint for one app's tokens. */
    public function revocationEndpoint(OAuthProvider $provider): ?string
    {
        return match ($provider) {
            OAuthProvider::Google => 'https://oauth2.googleapis.com/revoke',
            OAuthProvider::Microsoft => null,
        };
    }

    /**
     * Where an administrator of a Microsoft organization approves Tresso for all its users: in this installation's
     * tenant when it is registered for one, otherwise in the organization of the address (any directory when unknown).
     * Microsoft sends the administrator back to the callback afterwards.
     */
    public function adminConsentUrl(?string $emailAddress): string
    {
        $domain = null === $emailAddress ? '' : strtolower(substr((string) strrchr($emailAddress, '@'), 1));
        $tenant = \in_array(strtolower($this->tenant()), ['common', 'organizations', 'consumers'], true)
            ? ('' !== $domain ? $domain : 'organizations')
            : $this->tenant();

        return 'https://login.microsoftonline.com/'.rawurlencode($tenant).'/adminconsent?'.http_build_query([
            'client_id' => $this->clientId(OAuthProvider::Microsoft),
            'redirect_uri' => $this->redirectUri(OAuthProvider::Microsoft),
        ], '', '&', \PHP_QUERY_RFC3986);
    }

    private function tenant(): string
    {
        return '' === $this->microsoftTenant ? 'common' : $this->microsoftTenant;
    }
}
