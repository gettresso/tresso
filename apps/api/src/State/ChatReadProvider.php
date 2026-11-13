<?php

declare(strict_types=1);

namespace App\State;

use ApiPlatform\Metadata\Operation;
use ApiPlatform\State\ProviderInterface;
use ApiPlatform\Validator\Exception\ValidationException;
use App\ApiResource\ChatList;
use App\ApiResource\ChatSearch;
use App\ApiResource\ChatStatus;
use App\ApiResource\ChatTimeline;
use App\Chat\ChatCursor;
use App\Chat\ChatReader;
use App\Security\CurrentUser;
use Symfony\Component\DependencyInjection\Attribute\Autowire;
use Symfony\Component\HttpFoundation\Request;
use Symfony\Component\HttpKernel\Exception\TooManyRequestsHttpException;
use Symfony\Component\RateLimiter\RateLimiterFactoryInterface;
use Symfony\Component\Validator\ConstraintViolation;
use Symfony\Component\Validator\ConstraintViolationList;

/**
 * The read endpoints of WhatsApp for callers that keep no copy through the delta ({@see ChatReader}). Who may call is
 * decided by the operation's security ({@see \App\Security\ChatAccessVoter}); everything is read through the signed-in
 * user. Query parameters are checked here: a value out of range is a 422 that names the parameter, a cursor this API
 * did not give a 400.
 *
 * @implements ProviderInterface<ChatStatus|ChatList|ChatTimeline|ChatSearch>
 */
final readonly class ChatReadProvider implements ProviderInterface
{
    public const string STATUS = 'chat_status';
    public const string CHATS = 'chat_list';
    public const string TIMELINE = 'chat_timeline';
    public const string SEARCH = 'chat_search';

    public function __construct(
        private ChatReader $reader,
        private CurrentUser $currentUser,
        #[Autowire(service: 'limiter.chat_search')]
        private RateLimiterFactoryInterface $searchLimiter,
    ) {
    }

    public function provide(Operation $operation, array $uriVariables = [], array $context = []): ChatStatus|ChatList|ChatTimeline|ChatSearch
    {
        $user = $this->currentUser->get();
        $request = $context['request'] ?? null;
        $query = $request instanceof Request ? $request->query->all() : [];

        switch ($operation->getName()) {
            case self::STATUS:
                return ChatStatus::fromArray($this->reader->status($user));
            case self::CHATS:
                $limit = self::integer($query, 'limit', ChatReader::DEFAULT_CHATS, 1, ChatReader::MAX_LIMIT);
                $page = $this->reader->chats($user, $limit, ChatCursor::fromQuery($query['cursor'] ?? null));

                return new ChatList($page['items'], $page['nextCursor']);
            case self::TIMELINE:
                $limit = self::integer($query, 'limit', ChatReader::DEFAULT_MESSAGES, 1, ChatReader::MAX_LIMIT);
                $id = $uriVariables['id'] ?? null;
                $page = $this->reader->timeline($user, \is_string($id) ? $id : '', $limit, ChatCursor::fromQuery($query['cursor'] ?? null));

                return new ChatTimeline($page['chat'], $page['items'], $page['nextCursor']);
            case self::SEARCH:
                $text = self::searchText($query['q'] ?? null);
                $days = self::integer($query, 'days', ChatReader::SEARCH_DEFAULT_DAYS, 1, ChatReader::SEARCH_MAX_DAYS);
                $limit = self::integer($query, 'limit', ChatReader::SEARCH_DEFAULT_LIMIT, 1, ChatReader::SEARCH_MAX_LIMIT);
                $chatId = $query['chatId'] ?? null;
                if (null !== $chatId && !\is_string($chatId)) {
                    throw self::invalid('chatId', 'chatId must be the id of a chat.');
                }
                $cursor = ChatCursor::fromQuery($query['cursor'] ?? null);
                $allowed = $this->searchLimiter->create($user->getId()->toRfc4122())->consume();
                if (!$allowed->isAccepted()) {
                    throw new TooManyRequestsHttpException(max(1, $allowed->getRetryAfter()->getTimestamp() - time()), 'Too many WhatsApp searches at once. Wait a few minutes, then search again.');
                }
                $result = $this->reader->search($user, $text, $days, '' === $chatId ? null : $chatId, $limit, $cursor);

                return new ChatSearch($result['items'], $result['query'], $result['from'], $result['scanned'], $result['scanLimit'], $result['searchedThrough'], $result['complete'], $result['nextCursor']);
            default:
                throw new \LogicException(\sprintf('ChatReadProvider does not serve %s.', $operation->getName()));
        }
    }

    /**
     * @param array<mixed> $query
     */
    private static function integer(array $query, string $name, int $default, int $min, int $max): int
    {
        $value = $query[$name] ?? null;
        if (null === $value || '' === $value) {
            return $default;
        }
        if (!\is_string($value) || 1 !== preg_match('/^\d{1,6}$/', $value) || (int) $value < $min || (int) $value > $max) {
            throw self::invalid($name, \sprintf('%s must be a whole number from %d to %d.', $name, $min, $max));
        }

        return (int) $value;
    }

    /** What to search for: trimmed, without control characters, of a length a search can use. */
    private static function searchText(mixed $value): string
    {
        $text = \is_string($value) ? trim($value) : '';
        if (1 === preg_match('/[\x00-\x1F\x7F]/', $text) || 1 !== preg_match('//u', $text)) {
            throw self::invalid('q', 'q cannot contain control characters.');
        }
        $length = mb_strlen($text);
        if ($length < ChatReader::QUERY_MIN || $length > ChatReader::QUERY_MAX) {
            throw self::invalid('q', \sprintf('q must be %d to %d characters.', ChatReader::QUERY_MIN, ChatReader::QUERY_MAX));
        }

        return $text;
    }

    private static function invalid(string $parameter, string $message): ValidationException
    {
        return new ValidationException(new ConstraintViolationList([
            new ConstraintViolation($message, null, [], null, $parameter, null),
        ]));
    }
}
