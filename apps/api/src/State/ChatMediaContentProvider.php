<?php

declare(strict_types=1);

namespace App\State;

use ApiPlatform\Metadata\Operation;
use ApiPlatform\State\ProviderInterface;
use App\Chat\ChatFields;
use App\Chat\ChatMediaUrls;
use App\Entity\ChatMessage;
use App\Enum\ChatMediaState;
use App\Mail\Body\AttachmentResponse;
use App\Scan\DownloadPolicy;
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
 * Streams a WhatsApp file for a valid signed link, after its scan allows it, the way attachments are served: the name
 * the user sees is WhatsApp's without any folder, and the content is never sniffed or run.
 *
 * @implements ProviderInterface<StreamedResponse>
 */
final readonly class ChatMediaContentProvider implements ProviderInterface
{
    public function __construct(
        private EntityManagerInterface $entityManager,
        private ChatFields $fields,
        private BlobVault $blobs,
        private UriSigner $signer,
        private RequestStack $requests,
        private DownloadPolicy $downloads,
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
        $message = \is_string($id) && Uuid::isValid($id) ? $this->entityManager->find(ChatMessage::class, Uuid::fromString($id)) : null;
        $key = $message?->getMediaObjectKey();
        $status = $message?->getMediaScanStatus();
        if (!$message instanceof ChatMessage || ChatMediaState::Stored !== $message->getMediaState() || null === $key || null === $status) {
            throw new NotFoundHttpException('File not found.');
        }
        $refusal = $this->downloads->refusal($status, ChatMediaUrls::isConfirmedUnscanned($request));
        if (null !== $refusal) {
            throw $refusal;
        }

        try {
            $chunks = $this->blobs->stream($message->getChatAccount()->getOwner()->getId(), $key);
        } catch (ObjectNotFound $exception) {
            throw new ServiceUnavailableHttpException(null, 'The content of this file is not available.', $exception);
        }

        return AttachmentResponse::stream(
            $chunks,
            ChatMediaContentProvider::safeName($this->fields->mediaName($message), $message->getMediaKind()->value ?? 'file'),
            $message->getMediaContentType() ?? 'application/octet-stream',
            $message->getMediaSha256() ?? $key,
        );
    }

    /**
     * The name a download gets: the last part of WhatsApp's name, without control characters or leading dots, at most
     * 255 characters; `WhatsApp <kind>` when nothing is left. A name never brings a folder along.
     */
    public static function safeName(?string $name, string $kind): string
    {
        $name = basename(str_replace('\\', '/', $name ?? ''));
        $name = ltrim(trim((string) preg_replace('/[\x00-\x1f\x7f]+/u', '', $name)), '.');
        $name = mb_substr($name, 0, 255);

        return '' === $name ? 'WhatsApp '.$kind : $name;
    }
}
