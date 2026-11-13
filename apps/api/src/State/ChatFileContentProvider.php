<?php

declare(strict_types=1);

namespace App\State;

use ApiPlatform\Metadata\Operation;
use ApiPlatform\State\ProviderInterface;
use App\Chat\ChatFields;
use App\Entity\ChatOutgoing;
use App\Enum\ChatOutgoingStatus;
use App\Mail\Body\AttachmentResponse;
use App\Storage\BlobVault;
use App\Storage\ObjectNotFound;
use Doctrine\ORM\EntityManagerInterface;
use Symfony\Component\HttpFoundation\Exception\SignedUriException;
use Symfony\Component\HttpFoundation\RequestStack;
use Symfony\Component\HttpFoundation\StreamedResponse;
use Symfony\Component\HttpFoundation\UriSigner;
use Symfony\Component\HttpKernel\Exception\AccessDeniedHttpException;
use Symfony\Component\HttpKernel\Exception\NotFoundHttpException;
use Symfony\Component\HttpKernel\Exception\ServiceUnavailableHttpException;
use Symfony\Component\Uid\Uuid;

/**
 * Streams the file a reply carries for a valid signed link, only while the reply is being sent: the relaying desktop
 * fetches it right after its claim. Served as a download (`application/octet-stream`) whatever it is.
 *
 * @implements ProviderInterface<StreamedResponse>
 */
final readonly class ChatFileContentProvider implements ProviderInterface
{
    public function __construct(
        private EntityManagerInterface $entityManager,
        private ChatFields $fields,
        private BlobVault $blobs,
        private UriSigner $signer,
        private RequestStack $requests,
    ) {
    }

    public function provide(Operation $operation, array $uriVariables = [], array $context = []): StreamedResponse
    {
        $request = $this->requests->getCurrentRequest() ?? throw new \LogicException('File content is only served over HTTP.');
        try {
            $this->signer->verify($request);
        } catch (SignedUriException $exception) {
            throw new AccessDeniedHttpException('This link is invalid or has expired.', $exception);
        }

        $id = $uriVariables['id'] ?? null;
        $outgoing = \is_string($id) && Uuid::isValid($id) ? $this->entityManager->find(ChatOutgoing::class, Uuid::fromString($id)) : null;
        $key = $outgoing?->getFileObjectKey();
        if (!$outgoing instanceof ChatOutgoing || null === $key || ChatOutgoingStatus::Sending !== $outgoing->getStatus()) {
            throw new NotFoundHttpException('File not found.');
        }

        try {
            $chunks = $this->blobs->stream($outgoing->getChatAccount()->getOwner()->getId(), $key);
        } catch (ObjectNotFound $exception) {
            throw new ServiceUnavailableHttpException(null, 'The content of this file is not available.', $exception);
        }

        return AttachmentResponse::stream(
            $chunks,
            ChatMediaContentProvider::safeName($this->fields->outgoingFileName($outgoing), 'file'),
            'application/octet-stream',
            $outgoing->getFileSha256() ?? $key,
        );
    }
}
