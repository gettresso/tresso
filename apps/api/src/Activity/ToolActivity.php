<?php

declare(strict_types=1);

namespace App\Activity;

use App\Entity\User;
use App\Mcp\ApiFailure;
use App\Mcp\Tool\Tool;
use App\Security\Scope;
use Psr\Clock\ClockInterface;
use Symfony\Bundle\SecurityBundle\Security;

/**
 * Puts every MCP tool call of an app that is not ours in the activity log: the tool's name, the kind of its effect, the
 * result with a reason, the time it took, the scopes the tool needs and what it touched ({@see ToolTrace}). Never its
 * arguments or its answer. {@see \App\Mcp\ToolHandler} calls {@see start()} before a call and {@see finish()} after.
 */
final readonly class ToolActivity
{
    public function __construct(
        private Security $security,
        private ToolTrace $trace,
        private ActivityLog $log,
        private ClockInterface $clock,
    ) {
    }

    /**
     * @return array{int, \DateTimeImmutable}
     */
    public function start(): array
    {
        $this->trace->start();

        return [hrtime(true), $this->clock->now()];
    }

    /**
     * @param array{int, \DateTimeImmutable} $started what {@see start()} answered
     */
    public function finish(array $started, Tool $tool, ?ActivityReason $reason): void
    {
        $touched = $this->trace->stop();
        $token = $this->security->getToken();
        $user = $token?->getUser();
        $app = ActivityApp::of($token);
        if (!$user instanceof User || null === $app) {
            return;
        }
        [$at, $occurredAt] = $started;

        try {
            $this->log->record(new ActivityEntry(
                $user->getId(),
                $occurredAt,
                $app,
                ActivityChannel::Mcp,
                null,
                $tool->name,
                ActivityKind::ofTool($tool->effect),
                $reason,
                intdiv(hrtime(true) - $at, 1_000_000),
                array_map(static fn (Scope $scope): string => $scope->value, $tool->scopes),
                $touched?->objectType,
                null !== $touched && $touched->objectList,
                $touched?->objectId,
            ));
        } catch (\Throwable) {
            // The log never fails a tool call.
        }
    }

    /** The reason of a tool that threw something other than a refusal of the API. */
    public static function failureOf(\Throwable $exception): ActivityReason
    {
        return $exception instanceof ApiFailure ? (ActivityReason::ofStatus($exception->status) ?? ActivityReason::ServerError) : ActivityReason::ServerError;
    }
}
