<?php

declare(strict_types=1);

namespace App\State;

use ApiPlatform\Metadata\Operation;
use ApiPlatform\State\ProviderInterface;
use ApiPlatform\Validator\Exception\ValidationException;
use App\Activity\ActivityApp;
use App\Activity\ActivityCursor;
use App\Activity\ActivityDescriber;
use App\Activity\ActivityKind;
use App\Activity\ActivityResult;
use App\ApiResource\AppActivityPage;
use App\Repository\AppActivityRepository;
use App\Security\CurrentUser;
use Psr\Clock\ClockInterface;
use Symfony\Component\HttpFoundation\Request;
use Symfony\Component\Validator\ConstraintViolation;
use Symfony\Component\Validator\ConstraintViolationList;

/**
 * A page of the signed-in user's activity log, filtered as the query asks ({@see AppActivityPage}).
 *
 * @implements ProviderInterface<AppActivityPage>
 */
final readonly class AppActivityProvider implements ProviderInterface
{
    public const array PERIODS = ['24h' => 'PT24H', '7d' => 'P7D', '30d' => 'P30D', '90d' => 'P90D'];
    public const string DEFAULT_PERIOD = '90d';
    public const int DEFAULT_LIMIT = 50;
    public const int MAX_LIMIT = 100;

    public function __construct(
        private AppActivityRepository $activity,
        private ActivityDescriber $describer,
        private CurrentUser $currentUser,
        private ClockInterface $clock,
    ) {
    }

    public function provide(Operation $operation, array $uriVariables = [], array $context = []): AppActivityPage
    {
        $request = $context['request'] ?? null;
        $query = $request instanceof Request ? $request->query->all() : [];
        $user = $this->currentUser->get();

        $period = self::string($query, 'period') ?? self::DEFAULT_PERIOD;
        if (!isset(self::PERIODS[$period])) {
            throw self::invalid('period', 'period must be 24h, 7d, 30d or 90d.');
        }
        $app = null;
        if (null !== ($key = self::string($query, 'app'))) {
            $app = ActivityApp::fromKey($key) ?? throw self::invalid('app', 'app must be the activityKey of a connected app or a personal access token.');
        }
        $kind = null;
        if (null !== ($value = self::string($query, 'kind'))) {
            $kind = ActivityKind::tryFrom($value) ?? throw self::invalid('kind', 'kind must be read, change or send.');
        }
        $result = null;
        if (null !== ($value = self::string($query, 'result'))) {
            $result = ActivityResult::tryFrom($value) ?? throw self::invalid('result', 'result must be done, refused or failed.');
        }
        $cursor = null;
        if (null !== ($value = self::string($query, 'cursor'))) {
            $cursor = ActivityCursor::fromString($value) ?? throw self::invalid('cursor', 'cursor must be the nextCursor of the page before.');
        }
        $limit = self::DEFAULT_LIMIT;
        if (null !== ($value = self::string($query, 'limit'))) {
            if (1 !== preg_match('/^\d{1,3}$/', $value) || (int) $value < 1 || (int) $value > self::MAX_LIMIT) {
                throw self::invalid('limit', \sprintf('limit must be a whole number from 1 to %d.', self::MAX_LIMIT));
            }
            $limit = (int) $value;
        }

        $since = $this->clock->now()->sub(new \DateInterval(self::PERIODS[$period]));
        $rows = $this->activity->findPage($user, $since, $app, $kind, $result, $cursor, $limit);
        $next = null;
        if (\count($rows) > $limit) {
            $rows = \array_slice($rows, 0, $limit);
            $next = ActivityCursor::after($rows[$limit - 1])->toString();
        }

        return new AppActivityPage(
            $this->describer->describe($user, $rows),
            $next,
            $this->describer->appList($user, $this->activity->findApps($user, $since)),
            $this->activity->isEmpty($user),
        );
    }

    /**
     * @param array<mixed> $query
     */
    private static function string(array $query, string $name): ?string
    {
        $value = $query[$name] ?? null;
        if (null === $value || '' === $value) {
            return null;
        }
        if (\is_int($value)) {
            return (string) $value;
        }
        if (!\is_string($value)) {
            throw self::invalid($name, \sprintf('%s must be given once, as text.', $name));
        }

        return $value;
    }

    private static function invalid(string $parameter, string $message): ValidationException
    {
        return new ValidationException(new ConstraintViolationList([
            new ConstraintViolation($message, null, [], null, $parameter, null),
        ]));
    }
}
