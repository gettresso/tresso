<?php

declare(strict_types=1);

namespace App\Mcp\Security;

use App\Entity\User;
use App\Security\PersonalAccessToken\PersonalAccessTokenAuthentication;
use League\Bundle\OAuth2ServerBundle\Security\Authentication\Token\OAuth2Token;
use Mcp\Event\RequestEvent as McpRequestEvent;
use Mcp\Schema\JsonRpc\Error;
use Mcp\Schema\Request\InitializeRequest;
use Mcp\Server\Session\SessionStoreInterface;
use Mcp\Server\Transport\StreamableHttpTransport;
use Psr\Log\LoggerInterface;
use Symfony\Bundle\SecurityBundle\Security;
use Symfony\Component\DependencyInjection\Attribute\Autowire;
use Symfony\Component\EventDispatcher\EventSubscriberInterface;
use Symfony\Component\HttpFoundation\JsonResponse;
use Symfony\Component\HttpFoundation\Response;
use Symfony\Component\HttpKernel\Event\RequestEvent;
use Symfony\Component\HttpKernel\KernelEvents;
use Symfony\Component\Uid\Uuid;

/**
 * Ties an MCP session to the connection that started it: the user and the app (or personal access token) signed in
 * on `initialize`. A request that names a session of another user or app is answered as if the session did not
 * exist (404), so a session id is worth nothing to anyone else. Every tool still acts with the token of the request
 * itself; this only keeps one connection's session (its client details and protocol version) to itself.
 */
final readonly class McpSessionOwner implements EventSubscriberInterface
{
    public const string SESSION_KEY = 'tresso_owner';

    public function __construct(
        private Security $security,
        #[Autowire(service: 'mcp.server.default.session.store')]
        private SessionStoreInterface $sessions,
        private LoggerInterface $logger,
    ) {
    }

    public static function getSubscribedEvents(): array
    {
        return [
            // After the firewall (8), which signs the request in.
            KernelEvents::REQUEST => ['onKernelRequest', 0],
            McpRequestEvent::class => 'onMcpRequest',
        ];
    }

    public function onMcpRequest(McpRequestEvent $event): void
    {
        if (!$event->getRequest() instanceof InitializeRequest) {
            return;
        }

        $event->getSession()->set(self::SESSION_KEY, $this->owner());
    }

    public function onKernelRequest(RequestEvent $event): void
    {
        $request = $event->getRequest();
        if (!$event->isMainRequest() || McpAuthenticationChallenge::FIREWALL !== $this->security->getFirewallConfig($request)?->getName()) {
            return;
        }

        $sessionId = (string) $request->headers->get(StreamableHttpTransport::SESSION_HEADER, '');
        if ('' === $sessionId) {
            return;
        }

        // Session ids are handed out as RFC 9562 text. The SDK would also read the same id written in base58, base32
        // or binary, which would get around a check of the text form only: anything else is no session of ours.
        if (!Uuid::isValid($sessionId)) {
            $this->refuse($event, 'MCP session refused: the session id is not written as a UUID.');

            return;
        }

        $stored = $this->sessions->read(Uuid::fromString($sessionId));
        if (false === $stored) {
            // Unknown or expired: the SDK answers that itself.
            return;
        }

        $data = json_decode($stored, true);
        if (\is_array($data) && ($data[self::SESSION_KEY] ?? null) === $this->owner()) {
            return;
        }

        $this->refuse($event, 'MCP session refused: it was started by another user or app.');
    }

    private function refuse(RequestEvent $event, string $reason): void
    {
        $this->logger->warning($reason);
        $event->setResponse(new JsonResponse(
            json_encode(Error::forInvalidRequest('Session not found or has expired.'), \JSON_THROW_ON_ERROR),
            Response::HTTP_NOT_FOUND,
            [],
            true,
        ));
    }

    /**
     * The user and the app of the request, such as `0193...|claude-client-id` or `0193...|pat:<token id>`.
     */
    private function owner(): string
    {
        $token = $this->security->getToken();
        $user = $token?->getUser();
        if (!$user instanceof User || !$token instanceof OAuth2Token) {
            throw new \LogicException('An MCP request is signed in with a user\'s token (see McpUserVoter).');
        }

        $client = $token instanceof PersonalAccessTokenAuthentication
            ? 'pat:'.$token->getPersonalAccessTokenId()
            : $token->getOAuthClientId();

        return $user->getId()->toRfc4122().'|'.$client;
    }
}
