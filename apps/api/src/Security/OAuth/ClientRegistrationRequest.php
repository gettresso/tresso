<?php

declare(strict_types=1);

namespace App\Security\OAuth;

/**
 * The client metadata (RFC 7591 2) an app sends to register itself, checked against what an app that is not ours may
 * be: a public client (`token_endpoint_auth_method` `none`) using the authorization code grant with PKCE, optionally
 * with refresh tokens. Metadata this server does not use (`client_uri`, `logo_uri`, `contacts`, ...) is ignored, as
 * RFC 7591 allows; nothing of it is stored or shown.
 */
final readonly class ClientRegistrationRequest
{
    public const int MAX_REDIRECT_URIS = 10;
    public const int MAX_NAME_LENGTH = 100;

    private function __construct(
        /** @var non-empty-string */
        public string $clientName,
        /** @var non-empty-list<non-empty-string> */
        public array $redirectUris,
        /** @var non-empty-list<non-empty-string> */
        public array $grantTypes,
        /** @var non-empty-list<non-empty-string> */
        public array $scopes,
    ) {
    }

    /**
     * @param array<mixed> $metadata the decoded JSON body
     *
     * @throws ClientRegistrationRefused
     */
    public static function fromMetadata(array $metadata, RedirectUriPolicy $redirectUris, TressoLookalikes $tresso): self
    {
        $method = $metadata['token_endpoint_auth_method'] ?? null;
        if (null !== $method && 'none' !== $method) {
            throw ClientRegistrationRefused::metadata('Only public clients can register: token_endpoint_auth_method must be "none", and the app proves itself with PKCE.');
        }
        $responseTypes = $metadata['response_types'] ?? null;
        if (null !== $responseTypes && ['code'] !== $responseTypes) {
            throw ClientRegistrationRefused::metadata('Only the response type "code" is supported.');
        }

        return new self(
            self::clientName($metadata['client_name'] ?? null, $tresso),
            self::redirectUris($metadata['redirect_uris'] ?? null, $redirectUris),
            self::grantTypes($metadata['grant_types'] ?? null),
            self::scopes($metadata['scope'] ?? null),
        );
    }

    /** @return non-empty-string */
    private static function clientName(mixed $name, TressoLookalikes $tresso): string
    {
        if (!\is_string($name)) {
            throw ClientRegistrationRefused::metadata('client_name is required: the name people see when they are asked to allow the app.');
        }
        $name = trim($name);
        if ('' === $name || mb_strlen($name) > self::MAX_NAME_LENGTH) {
            throw ClientRegistrationRefused::metadata(\sprintf('client_name must be 1 to %d characters long.', self::MAX_NAME_LENGTH));
        }
        // Control and invisible formatting characters (such as right-to-left overrides) could make the name read as
        // something else on the consent screen.
        if (1 === preg_match('/[\p{Cc}\p{Cf}]/u', $name)) {
            throw ClientRegistrationRefused::metadata('client_name cannot contain control or formatting characters.');
        }
        // Only the plain space separates words: other spaces (no-break, hair, line and paragraph separators) can hide
        // a word between its letters.
        if (1 === preg_match('/\p{Z}/u', str_replace(' ', '', $name))) {
            throw ClientRegistrationRefused::metadata('client_name can only use ordinary spaces.');
        }
        if (!TressoLookalikes::isLatin($name)) {
            throw ClientRegistrationRefused::metadata('client_name must be written in Latin letters, digits and punctuation, so people read it as it is.');
        }
        if ($tresso->namesTresso($name)) {
            throw ClientRegistrationRefused::metadata('client_name cannot name Tresso: only Tresso\'s own apps do.');
        }

        return $name;
    }

    /** @return non-empty-list<non-empty-string> */
    private static function redirectUris(mixed $uris, RedirectUriPolicy $policy): array
    {
        if (!\is_array($uris) || !array_is_list($uris) || [] === $uris) {
            throw ClientRegistrationRefused::redirectUri('redirect_uris is required: a list of at least one URI.');
        }
        if (\count($uris) > self::MAX_REDIRECT_URIS) {
            throw ClientRegistrationRefused::redirectUri(\sprintf('Register at most %d redirect URIs.', self::MAX_REDIRECT_URIS));
        }
        $checked = [];
        foreach ($uris as $uri) {
            if (!\is_string($uri) || '' === $uri) {
                throw ClientRegistrationRefused::redirectUri('Every redirect URI must be a non-empty string.');
            }
            $policy->check($uri);
            $checked[] = $uri;
        }

        return array_values(array_unique($checked));
    }

    /**
     * Without grant_types an app gets both: refresh tokens are what keeps an MCP client signed in.
     *
     * @return non-empty-list<non-empty-string>
     */
    private static function grantTypes(mixed $grantTypes): array
    {
        if (null === $grantTypes) {
            return ThirdPartyClients::GRANT_TYPES;
        }
        if (!\is_array($grantTypes) || !array_is_list($grantTypes)) {
            throw ClientRegistrationRefused::metadata('grant_types must be a list.');
        }
        foreach ($grantTypes as $grantType) {
            if (!\is_string($grantType) || !\in_array($grantType, ThirdPartyClients::GRANT_TYPES, true)) {
                throw ClientRegistrationRefused::metadata('Only the grant types authorization_code and refresh_token are supported.');
            }
        }
        if (!\in_array('authorization_code', $grantTypes, true)) {
            throw ClientRegistrationRefused::metadata('grant_types must include authorization_code.');
        }

        /** @var non-empty-list<non-empty-string> */
        return array_values(array_unique($grantTypes));
    }

    /**
     * Without a scope an app may ask for every scope an app that is not ours may have except the chat scopes, which it
     * must name; what it gets is still what the user allows.
     *
     * @return non-empty-list<non-empty-string>
     */
    private static function scopes(mixed $scope): array
    {
        if (null === $scope) {
            /** @var non-empty-list<non-empty-string> */
            return ThirdPartyClients::defaultScopeValues();
        }
        if (!\is_string($scope)) {
            throw ClientRegistrationRefused::metadata('scope must be a string of scopes separated by spaces.');
        }
        $scopes = array_values(array_unique(array_filter(explode(' ', $scope), static fn (string $value): bool => '' !== $value)));
        if ([] === $scopes) {
            throw ClientRegistrationRefused::metadata('scope names no scope.');
        }
        foreach ($scopes as $value) {
            if (!ThirdPartyClients::mayAskFor($value)) {
                throw ClientRegistrationRefused::metadata(\sprintf('An app cannot ask for the scope "%s". Supported: %s.', $value, implode(' ', ThirdPartyClients::scopeValues())));
            }
        }

        return $scopes;
    }
}
