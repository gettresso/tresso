<?php

declare(strict_types=1);

namespace App\State;

use ApiPlatform\Metadata\Operation;
use ApiPlatform\State\ProviderInterface;
use ApiPlatform\Validator\Exception\ValidationException;
use App\ApiResource\ChatList;
use App\ApiResource\ChatStatus;
use App\ApiResource\ChatTimeline;
use App\Chat\ChatCursor;
use App\Chat\ChatReader;
use App\Security\ChatAccessVoter;
use App\Security\CurrentUser;
use Symfony\Component\HttpFoundation\Request;
use Symfony\Component\Security\Core\Authorization\AuthorizationCheckerInterface;
use Symfony\Component\Validator\ConstraintViolation;
use Symfony\Component\Validator\ConstraintViolationList;

/**
 * The read endpoints of WhatsApp for callers that keep no copy through the delta ({@see ChatReader}); the search is
 * {@see ChatSearchProcessor}. Who may call is decided by the operation's security ({@see \App\Security\ChatAccessVoter}); everything is read through the signed-in
 * user. Query parameters are checked here: a value out of range is a 422 that names the parameter, a cursor this API
 * did not give a 400.
 *
 * @implements ProviderInterface<ChatStatus|ChatList|ChatTimeline>
 */
final readonly class ChatReadProvider implements ProviderInterface
{
    public const string STATUS = 'chat_status';
    public const string CHATS = 'chat_list';
    public const string TIMELINE = 'chat_timeline';

    public function __construct(
        private ChatReader $reader,
        private CurrentUser $currentUser,
        private AuthorizationCheckerInterface $authorizationChecker,
    ) {
    }

    public function provide(Operation $operation, array $uriVariables = [], array $context = []): ChatStatus|ChatList|ChatTimeline
    {
        $user = $this->currentUser->get();
        $request = $context['request'] ?? null;
        $query = $request instanceof Request ? $request->query->all() : [];

        switch ($operation->getName()) {
            case self::STATUS:
                $status = $this->reader->status($user);
                // The name the user gave their Mac is theirs, not part of queueing a reply: only for callers that read.
                if (!$this->authorizationChecker->isGranted(ChatAccessVoter::READ)) {
                    $status['relayDeviceName'] = null;
                }

                return ChatStatus::fromArray($status);
            case self::CHATS:
                $limit = self::integer($query, 'limit', ChatReader::DEFAULT_CHATS, 1, ChatReader::MAX_LIMIT);
                $page = $this->reader->chats($user, $limit, ChatCursor::fromQuery($query['cursor'] ?? null));

                return new ChatList($page['items'], $page['nextCursor']);
            case self::TIMELINE:
                $limit = self::integer($query, 'limit', ChatReader::DEFAULT_MESSAGES, 1, ChatReader::MAX_LIMIT);
                $id = $uriVariables['id'] ?? null;
                $page = $this->reader->timeline($user, \is_string($id) ? $id : '', $limit, ChatCursor::fromQuery($query['cursor'] ?? null));

                return new ChatTimeline($page['chat'], $page['items'], $page['nextCursor']);
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
        // A sub-request made in PHP (an MCP tool through App\Mcp\Api) keeps a number a number.
        if (\is_int($value)) {
            $value = (string) $value;
        }
        if (!\is_string($value) || 1 !== preg_match('/^\d{1,6}$/', $value) || (int) $value < $min || (int) $value > $max) {
            throw self::invalid($name, \sprintf('%s must be a whole number from %d to %d.', $name, $min, $max));
        }

        return (int) $value;
    }

    private static function invalid(string $parameter, string $message): ValidationException
    {
        return new ValidationException(new ConstraintViolationList([
            new ConstraintViolation($message, null, [], null, $parameter, null),
        ]));
    }
}
