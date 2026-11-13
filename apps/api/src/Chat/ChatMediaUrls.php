<?php

declare(strict_types=1);

namespace App\Chat;

use App\ApiResource\ChatFileContent;
use App\ApiResource\ChatMediaContent;
use App\Entity\ChatMessage;
use App\Entity\ChatOutgoing;
use App\Enum\ChatMediaState;
use App\Scan\AttachmentAccess;
use App\Scan\DownloadPolicy;
use Symfony\Component\HttpFoundation\Request;
use Symfony\Component\HttpFoundation\UriSigner;
use Symfony\Component\Routing\Generator\UrlGeneratorInterface;
use Symfony\Component\Uid\Uuid;

/**
 * Signed links to WhatsApp files, valid for an hour, as attachments have them ({@see \App\Mail\Body\AttachmentUrls}):
 * whoever holds one can fetch the file until it expires, so they are handed only to the file's owner (and a reply's
 * file only to the relaying desktop that claimed the reply).
 *
 * A received file has a link only once it is stored and scanned clean; one that could not be scanned only for a
 * confirmed request (`unscanned=1`, covered by the signature), and never on a server that requires scans.
 */
final readonly class ChatMediaUrls
{
    private const string LIFETIME = 'PT1H';
    private const string UNSCANNED = 'unscanned';

    public function __construct(
        private UrlGeneratorInterface $urls,
        private UriSigner $signer,
        private DownloadPolicy $downloads,
    ) {
    }

    /** What a client may do with the message's file; null while it is not stored. */
    public function access(ChatMessage $message): ?AttachmentAccess
    {
        $status = $message->getMediaScanStatus();

        return ChatMediaState::Stored === $message->getMediaState() && null !== $status ? $this->downloads->access($status) : null;
    }

    /** A link for a stored file that is clean, or with $confirmed for one that could not be scanned; null otherwise. */
    public function forMessage(ChatMessage $message, bool $confirmed): ?string
    {
        $access = $this->access($message);
        if (AttachmentAccess::Allowed === $access) {
            return $this->sign(ChatMediaContent::ROUTE, $message->getId(), false);
        }
        if ($confirmed && AttachmentAccess::Confirm === $access) {
            return $this->sign(ChatMediaContent::ROUTE, $message->getId(), true);
        }

        return null;
    }

    /** A link for the file a reply carries, for the relay that claimed it; null for a reply without a stored file. */
    public function forReply(ChatOutgoing $outgoing): ?string
    {
        return null === $outgoing->getFileObjectKey() ? null : $this->sign(ChatFileContent::ROUTE, $outgoing->getId(), false);
    }

    /** Whether a verified content request carries the confirmation of {@see forMessage()}. */
    public static function isConfirmedUnscanned(Request $request): bool
    {
        return '1' === $request->query->get(self::UNSCANNED);
    }

    private function sign(string $route, Uuid $id, bool $unscanned): string
    {
        return $this->signer->sign(
            $this->urls->generate($route, ['id' => $id->toRfc4122()] + ($unscanned ? [self::UNSCANNED => '1'] : []), UrlGeneratorInterface::ABSOLUTE_URL),
            new \DateInterval(self::LIFETIME),
        );
    }
}
