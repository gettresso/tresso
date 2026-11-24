<?php

declare(strict_types=1);

namespace App\Activity;

use ApiPlatform\Metadata\Resource\Factory\ResourceMetadataCollectionFactoryInterface;
use App\Entity\User;
use Psr\Clock\ClockInterface;
use Psr\Log\LoggerInterface;
use Symfony\Bundle\SecurityBundle\Security;
use Symfony\Component\EventDispatcher\Attribute\AsEventListener;
use Symfony\Component\HttpFoundation\Request;
use Symfony\Component\HttpFoundation\Response;
use Symfony\Component\HttpKernel\Event\RequestEvent;
use Symfony\Component\HttpKernel\Event\ResponseEvent;
use Symfony\Component\HttpKernel\KernelEvents;

/**
 * Puts every API request of an app that is not ours (an OAuth client or a personal access token) in the activity log:
 * the method and route template of the operation it reached, its kind, the result by the status of the response, the
 * time it took, the scopes the operation asks for and the resource and id from the path. Requests of our own apps, of
 * the sync worker and of callers nobody can name are not logged, nor sub-requests (an MCP tool logs itself, see
 * {@see ToolActivity}), nor requests that reached no API operation. A 401 is logged only for a caller
 * {@see RefusedCallers} names.
 */
final readonly class ApiRequestActivity
{
    private const string STARTED = '_app_activity_started';
    private const string PATH = '#^/api/#';

    public function __construct(
        private Security $security,
        private ResourceMetadataCollectionFactoryInterface $resources,
        private RefusedCallers $refusedCallers,
        private ActivityLog $log,
        private ClockInterface $clock,
        private LoggerInterface $logger,
    ) {
    }

    /** Before everything else, so the time includes signing in. */
    #[AsEventListener(event: KernelEvents::REQUEST, priority: 4096)]
    public function start(RequestEvent $event): void
    {
        if ($event->isMainRequest()) {
            $event->getRequest()->attributes->set(self::STARTED, [hrtime(true), $this->clock->now()]);
        }
    }

    /** Last, so the status is the one that goes out. */
    #[AsEventListener(event: KernelEvents::RESPONSE, priority: -4096)]
    public function finish(ResponseEvent $event): void
    {
        $request = $event->getRequest();
        if (!$event->isMainRequest() || 1 !== preg_match(self::PATH, $request->getPathInfo())) {
            return;
        }
        $started = $request->attributes->get(self::STARTED);
        if (!\is_array($started) || !\is_int($started[0] ?? null) || !($started[1] ?? null) instanceof \DateTimeImmutable) {
            return;
        }
        [$at, $occurredAt] = $started;
        $durationMs = intdiv(hrtime(true) - $at, 1_000_000);

        try {
            $this->record($request, $event->getResponse(), $occurredAt, $durationMs);
        } catch (\Throwable $exception) {
            // The log never fails a request; what could not be described is not logged, and that is an error of ours.
            $this->logger->error('An API request could not be put in the app activity log.', [
                'route' => $request->attributes->get('_route'),
                'status' => $event->getResponse()->getStatusCode(),
                'error' => $exception::class,
            ]);
        }
    }

    private function record(Request $request, Response $response, \DateTimeImmutable $occurredAt, int $durationMs): void
    {
        $operation = ApiOperation::of($request, $this->resources);
        if (null === $operation) {
            return;
        }

        $status = $response->getStatusCode();
        $token = $this->security->getToken();
        $user = $token?->getUser();
        $app = ActivityApp::of($token);
        if ($user instanceof User && null !== $app) {
            $owner = $user->getId();
            $reason = ActivityReason::ofStatus($status);
        } elseif (Response::HTTP_UNAUTHORIZED === $status && null === $token) {
            $caller = $this->refusedCallers->identify($request);
            if (null === $caller) {
                return;
            }
            ['owner' => $owner, 'app' => $app, 'reason' => $reason] = $caller;
        } else {
            return;
        }

        $this->log->record(new ActivityEntry(
            $owner,
            $occurredAt,
            $app,
            ActivityChannel::Api,
            $operation->method,
            $operation->route,
            $operation->kind,
            $reason,
            $durationMs,
            $operation->scopes,
            $operation->objectType,
            $operation->objectList,
            $operation->objectId,
            ActivityReason::NoPermission === $reason ? ActivityApp::missingScopes($operation->scopes, $token) : [],
        ));
    }
}
