<?php

declare(strict_types=1);

namespace App\State;

use ApiPlatform\Metadata\Operation;
use ApiPlatform\State\ProcessorInterface;
use App\ApiResource\ChatOutgoingResource;
use App\ApiResource\Input\Chat\RelayClaim;
use App\ApiResource\Input\Chat\RelayMediaClaim;
use App\ApiResource\Input\Chat\RelayMediaFailed;
use App\ApiResource\Input\Chat\RelayMessages;
use App\ApiResource\Input\Chat\RelayResult;
use App\ApiResource\ChatProblem;
use App\ApiResource\Input\Chat\RelayStatus;
use App\ApiResource\Output\Chat\RelayClaimOutput;
use App\ApiResource\Output\Chat\RelayImportOutput;
use App\ApiResource\Output\Chat\RelayMediaClaimOutput;
use App\ApiResource\Output\Chat\RelayMediaOutput;
use App\ApiResource\Output\Chat\RelayStatusOutput;
use App\Chat\ChatFields;
use App\Chat\ChatIngestor;
use App\Chat\ChatMedia;
use App\Chat\ChatMediaLimits;
use App\Chat\ChatMediaUrls;
use App\Chat\ChatQueue;
use App\Chat\ChatRelayGuard;
use App\Chat\ChatRequestBody;
use App\Chat\ChatTime;
use App\Chat\ChatViews;
use App\Security\CurrentUser;
use Doctrine\ORM\EntityManagerInterface;
use Symfony\Component\DependencyInjection\Attribute\Autowire;
use Symfony\Component\HttpFoundation\Request;
use Symfony\Component\HttpFoundation\Response;
use Symfony\Component\HttpKernel\Exception\TooManyRequestsHttpException;
use Symfony\Component\RateLimiter\RateLimiterFactoryInterface;

/**
 * The relay's calls. Each runs in one transaction behind {@see ChatRelayGuard}, which answers only the account's
 * relaying device and locks the account, so the calls of a relay take turns and a batch is stored whole or not at all.
 * A batch is read here (not by API Platform), so its size is checked before anything of it is decoded; batches are
 * limited per account (`chat_relay_import`).
 *
 * @implements ProcessorInterface<RelayStatus|RelayMessages|RelayClaim|RelayResult|RelayMediaClaim|RelayMediaFailed|null, RelayStatusOutput|RelayImportOutput|RelayClaimOutput|ChatOutgoingResource|RelayMediaClaimOutput|RelayMediaOutput|Response>
 */
final readonly class ChatRelayProcessor implements ProcessorInterface
{
    public function __construct(
        private EntityManagerInterface $entityManager,
        private ChatRelayGuard $guard,
        private ChatIngestor $ingestor,
        private ChatQueue $queue,
        private ChatFields $fields,
        private ChatViews $views,
        private CurrentUser $currentUser,
        private ChatRequestBody $body,
        #[Autowire(service: 'limiter.chat_relay_import')]
        private RateLimiterFactoryInterface $importLimiter,
        private ChatMedia $media,
        private ChatMediaUrls $urls,
        private ChatMediaLimits $limits,
    ) {
    }

    public function process(mixed $data, Operation $operation, array $uriVariables = [], array $context = []): RelayStatusOutput|RelayImportOutput|RelayClaimOutput|ChatOutgoingResource|RelayMediaClaimOutput|RelayMediaOutput|Response
    {
        $user = $this->currentUser->get();
        $now = ChatTime::stored(new \DateTimeImmutable());
        if ('chat_relay_messages' === $operation->getName()) {
            $request = $context['request'] ?? null;
            if (!$request instanceof Request) {
                throw new \LogicException('A batch needs the request.');
            }
            $data = $this->body->read($request, RelayMessages::class, RelayMessages::MAX_BYTES);
        }
        if (null === $data) {
            throw new \LogicException(\sprintf('No input for %s.', $operation->getName()));
        }

        $result = $this->entityManager->wrapInTransaction(function () use ($data, $uriVariables, $user, $now): RelayStatusOutput|RelayImportOutput|RelayClaimOutput|ChatOutgoingResource|RelayMediaClaimOutput|RelayMediaOutput|Response {
            if ($data instanceof RelayResult) {
                [$account, $fromRelay] = $this->guard->reportingAccount($user, $uriVariables['accountId'] ?? null, $data->deviceId, $now);

                return ChatOutgoingResource::fromView($this->views->outgoing($this->queue->report($account, $uriVariables['outgoingId'] ?? null, $data, $data->deviceId, $fromRelay, $now)));
            }
            $account = $this->guard->relayedAccount($user, $uriVariables['accountId'] ?? null, $data->deviceId, $now);

            if ($data instanceof RelayMessages) {
                // Per account, after the guard: a call for an account that is not the caller's costs that account nothing.
                $limit = $this->importLimiter->create($account->getId()->toRfc4122())->consume();
                if (!$limit->isAccepted()) {
                    throw new TooManyRequestsHttpException($limit->getRetryAfter()->getTimestamp() - time(), 'Too many batches at once. Wait a little, then send the next one.');
                }

                return $this->ingestor->ingest($account, $data, $now);
            }
            if ($data instanceof RelayClaim) {
                $claim = $this->queue->claim($account, $now);
                if (null === $claim) {
                    return new Response(null, Response::HTTP_NO_CONTENT);
                }
                [$outgoing, $token] = $claim;
                $fileName = $this->fields->outgoingFileName($outgoing);
                $fileUrl = $this->urls->forReply($outgoing);

                return new RelayClaimOutput(
                    $outgoing->getId()->toRfc4122(),
                    $outgoing->getChat()->getId()->toRfc4122(),
                    $this->fields->jid($outgoing->getChat()),
                    $this->fields->outgoingText($outgoing),
                    $token,
                    null === $fileName || null === $fileUrl ? null : ['name' => $fileName, 'size' => $outgoing->getFileSize() ?? 0, 'url' => $fileUrl],
                );
            }
            if ($data instanceof RelayMediaClaim) {
                $message = $this->media->claim($account, $now);
                if (null === $message) {
                    return new Response(null, Response::HTTP_NO_CONTENT);
                }

                return new RelayMediaClaimOutput(
                    $message->getId()->toRfc4122(),
                    $this->fields->jid($message->getChat()),
                    $this->fields->waId($message),
                    $message->getMediaKind()->value ?? throw new \LogicException('A requested file has a kind.'),
                    $message->getMediaSize(),
                    $this->limits->maxFileBytes,
                );
            }
            if ($data instanceof RelayMediaFailed) {
                $message = $this->media->fail($account, $uriVariables['messageId'] ?? null, $data->error ?? throw new \LogicException('Validation guarantees an error.'));

                return new RelayMediaOutput($message->getId()->toRfc4122(), $message->getMediaState()->value ?? '', $message->getMediaError()?->value);
            }

            if (null !== $data->address) {
                $stored = $this->fields->accountAddress($account);
                if (null !== $stored && $stored !== $data->address) {
                    throw ChatProblem::otherNumber();
                }
                if (null === $stored) {
                    // Learned now: from here on the account knows its number, for the next takeover's check.
                    $this->fields->setAccountIdentity($account, $data->address, $this->fields->accountDisplayName($account));
                }
            }
            $account->reportBridge(
                $data->bridge ?? throw new \LogicException('Validation guarantees a bridge state.'),
                $data->link ?? throw new \LogicException('Validation guarantees a link state.'),
                null === $data->linkedAt ? null : ChatTime::stored($data->linkedAt),
                $data->loopbackOnly,
            );

            return new RelayStatusOutput();
        });
        // The ingestor and the queue also work in SQL; no later request in this process sees stale entities.
        $this->entityManager->clear();

        return $result;
    }
}
