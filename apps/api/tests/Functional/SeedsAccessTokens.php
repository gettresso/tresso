<?php

declare(strict_types=1);

namespace App\Tests\Functional;

use League\OAuth2\Server\CryptKey;
use League\OAuth2\Server\Entities\ScopeEntityInterface;
use League\OAuth2\Server\Repositories\AccessTokenRepositoryInterface;
use League\OAuth2\Server\Repositories\ClientRepositoryInterface;
use League\OAuth2\Server\Repositories\ScopeRepositoryInterface;
use Symfony\Bundle\FrameworkBundle\KernelBrowser;

/**
 * An access token of an app that is not ours with scopes no such app can obtain yet (the chat scopes), made straight by
 * the authorization server's repositories and signed with its key: so the rules for those scopes are tested before an
 * app can be given them. Needs {@see AuthenticatesUsers} and {@see ConnectsThirdPartyApps}.
 *
 * @property KernelBrowser $client
 */
trait SeedsAccessTokens
{
    /**
     * @param list<string> $scopes
     *
     * @return array<string, string>
     */
    protected function seededThirdPartyHeaders(string $email, array $scopes): array
    {
        $this->resetRegistrationLimits();
        $this->client->jsonRequest('POST', '/oauth/register', ['client_name' => 'Some app', 'redirect_uris' => ['http://127.0.0.1:33418/callback']]);
        self::assertResponseStatusCodeSame(201);
        $clientId = $this->responseString('client_id');

        $container = static::getContainer();
        $client = $container->get(ClientRepositoryInterface::class)->getClientEntity($clientId);
        self::assertNotNull($client);
        $scopeRepository = $container->get(ScopeRepositoryInterface::class);
        $scopeEntities = array_map(static function (string $scope) use ($scopeRepository): ScopeEntityInterface {
            $entity = $scopeRepository->getScopeEntityByIdentifier($scope);
            self::assertNotNull($entity, $scope);

            return $entity;
        }, $scopes);

        $tokens = $container->get(AccessTokenRepositoryInterface::class);
        $token = $tokens->getNewToken($client, $scopeEntities, $email);
        $token->setIdentifier(bin2hex(random_bytes(40)));
        $token->setExpiryDateTime(new \DateTimeImmutable('+1 hour'));
        $key = $_SERVER['OAUTH_PRIVATE_KEY'] ?? null;
        $passphrase = $_SERVER['OAUTH_PASSPHRASE'] ?? null;
        self::assertIsString($key);
        self::assertIsString($passphrase);
        $token->setPrivateKey(new CryptKey(str_replace('%kernel.project_dir%', $container->getParameter('kernel.project_dir'), $key), $passphrase, false));
        $tokens->persistNewAccessToken($token);

        return ['HTTP_AUTHORIZATION' => 'Bearer '.$token->toString(), 'HTTP_ACCEPT' => 'application/json'];
    }
}
