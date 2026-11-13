<?php

declare(strict_types=1);

namespace App\State;

use ApiPlatform\Metadata\Operation;
use ApiPlatform\State\ProcessorInterface;
use App\ApiResource\ChatSearch;
use App\ApiResource\Input\Chat\SearchChats;
use App\Chat\ChatCursor;
use App\Chat\ChatReader;
use App\Chat\ChatRequestBody;
use App\Security\CallerKey;
use App\Security\CurrentUser;
use Symfony\Bundle\SecurityBundle\Security;
use Symfony\Component\DependencyInjection\Attribute\Autowire;
use Symfony\Component\HttpFoundation\Request;
use Symfony\Component\HttpKernel\Exception\TooManyRequestsHttpException;
use Symfony\Component\RateLimiter\RateLimiterFactoryInterface;

/**
 * Runs a search of the signed-in user's WhatsApp messages ({@see ChatReader::search()}). Who may is decided by the
 * operation's security ({@see \App\Security\ChatAccessVoter::READ}). The body is read and checked first (a 422 names
 * the fields, never the text); then the limits: per caller (an app or a personal access token of the user,
 * `chat_search_caller`) and, as the outer bound, per user (`chat_search`).
 *
 * @implements ProcessorInterface<SearchChats|null, ChatSearch>
 */
final readonly class ChatSearchProcessor implements ProcessorInterface
{
    public function __construct(
        private ChatReader $reader,
        private CurrentUser $currentUser,
        private ChatRequestBody $body,
        private Security $security,
        #[Autowire(service: 'limiter.chat_search')]
        private RateLimiterFactoryInterface $userLimiter,
        #[Autowire(service: 'limiter.chat_search_caller')]
        private RateLimiterFactoryInterface $callerLimiter,
    ) {
    }

    public function process(mixed $data, Operation $operation, array $uriVariables = [], array $context = []): ChatSearch
    {
        $request = $context['request'] ?? null;
        if (!$request instanceof Request) {
            throw new \LogicException('A search needs the request.');
        }
        $user = $this->currentUser->get();
        $input = $this->body->read($request, SearchChats::class, SearchChats::MAX_BYTES);
        $cursor = ChatCursor::fromQuery($input->cursor);

        $userKey = $user->getId()->toRfc4122();
        foreach ([$this->callerLimiter->create($userKey.'|'.CallerKey::of($this->security->getToken())), $this->userLimiter->create($userKey)] as $limiter) {
            $limit = $limiter->consume();
            if (!$limit->isAccepted()) {
                throw new TooManyRequestsHttpException(max(1, $limit->getRetryAfter()->getTimestamp() - time()), 'Too many WhatsApp searches at once. Wait a few minutes, then search again.');
            }
        }

        $result = $this->reader->search(
            $user,
            trim($input->q),
            $input->days ?? ChatReader::SEARCH_DEFAULT_DAYS,
            $input->chatId,
            $input->limit ?? ChatReader::SEARCH_DEFAULT_LIMIT,
            $cursor,
        );

        return new ChatSearch($result['items'], $result['query'], $result['from'], $result['scanned'], $result['scanLimit'], $result['searchedThrough'], $result['complete'], $result['nextCursor']);
    }
}
