<?php

declare(strict_types=1);

namespace App\State;

use ApiPlatform\Metadata\Operation;
use ApiPlatform\State\ProcessorInterface;
use App\ApiResource\ChatOutgoingResource;
use App\ApiResource\Input\Chat\RelayClaim;
use App\ApiResource\Input\Chat\RelayMessages;
use App\ApiResource\Input\Chat\RelayResult;
use App\ApiResource\Input\Chat\RelayStatus;
use App\ApiResource\Output\Chat\RelayClaimOutput;
use App\ApiResource\Output\Chat\RelayImportOutput;
use App\ApiResource\Output\Chat\RelayStatusOutput;
use App\Chat\ChatFields;
use App\Chat\ChatIngestor;
use App\Chat\ChatQueue;
use App\Chat\ChatRelayGuard;
use App\Chat\ChatTime;
use App\Chat\ChatViews;
use App\Security\CurrentUser;
use Doctrine\ORM\EntityManagerInterface;
use Symfony\Component\HttpFoundation\Response;

/**
 * The relay's calls. Each runs in one transaction behind {@see ChatRelayGuard}, which answers only the account's
 * relaying device and locks the account, so the calls of a relay take turns and a batch is stored whole or not at all.
 *
 * @implements ProcessorInterface<RelayStatus|RelayMessages|RelayClaim|RelayResult, RelayStatusOutput|RelayImportOutput|RelayClaimOutput|ChatOutgoingResource|Response>
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
    ) {
    }

    public function process(mixed $data, Operation $operation, array $uriVariables = [], array $context = []): RelayStatusOutput|RelayImportOutput|RelayClaimOutput|ChatOutgoingResource|Response
    {
        $user = $this->currentUser->get();
        $now = ChatTime::stored(new \DateTimeImmutable());

        $result = $this->entityManager->wrapInTransaction(function () use ($data, $uriVariables, $user, $now): RelayStatusOutput|RelayImportOutput|RelayClaimOutput|ChatOutgoingResource|Response {
            $account = $this->guard->relayedAccount($user, $uriVariables['accountId'] ?? null, $data->deviceId, $now);

            if ($data instanceof RelayStatus) {
                $account->reportBridge(
                    $data->bridge ?? throw new \LogicException('Validation guarantees a bridge state.'),
                    $data->link ?? throw new \LogicException('Validation guarantees a link state.'),
                    null === $data->linkedAt ? null : ChatTime::stored($data->linkedAt),
                    $data->loopbackOnly,
                );

                return new RelayStatusOutput();
            }
            if ($data instanceof RelayMessages) {
                return $this->ingestor->ingest($account, $data);
            }
            if ($data instanceof RelayClaim) {
                $outgoing = $this->queue->claim($account, $now);

                return null === $outgoing
                    ? new Response(null, Response::HTTP_NO_CONTENT)
                    : new RelayClaimOutput(
                        $outgoing->getId()->toRfc4122(),
                        $outgoing->getChat()->getId()->toRfc4122(),
                        $this->fields->jid($outgoing->getChat()),
                        $this->fields->outgoingText($outgoing),
                    );
            }

            return ChatOutgoingResource::fromView($this->views->outgoing($this->queue->report($account, $uriVariables['outgoingId'] ?? null, $data, $now)));
        });
        // The ingestor and the queue also work in SQL; no later request in this process sees stale entities.
        $this->entityManager->clear();

        return $result;
    }
}
