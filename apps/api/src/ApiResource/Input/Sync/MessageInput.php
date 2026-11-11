<?php

declare(strict_types=1);

namespace App\ApiResource\Input\Sync;

use App\Entity\MessageText;
use Symfony\Component\Validator\Constraints as Assert;
use Symfony\Component\Validator\Context\ExecutionContextInterface;

/**
 * One message in one folder, as parsed by the worker. The raw MIME and the attachments are already in object storage,
 * encrypted with the account owner's blob key of $keyVersion.
 */
final class MessageInput
{
    /** IMAP UID (or provider message id) within the folder. */
    #[Assert\NotBlank]
    #[Assert\Length(max: 255)]
    public string $remoteUid = '';

    #[Assert\PositiveOrZero]
    public ?int $modSeq = null;

    /** raw/<owner id>/<fingerprint[0:2]>/<fingerprint>; the owner is checked against the account's. */
    #[Assert\Regex('#^raw/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/([0-9a-f]{2})/\1[0-9a-f]{62}$#')]
    public string $rawObjectKey = '';

    /** The owner's key version the raw MIME and the attachments are encrypted with. */
    #[Assert\NotNull]
    #[Assert\Positive]
    public ?int $keyVersion = null;

    #[Assert\PositiveOrZero]
    public int $size = 0;

    /** When the server received it (IMAP INTERNALDATE). */
    #[Assert\NotNull]
    public ?\DateTimeImmutable $receivedAt = null;

    /** Date header. */
    public ?\DateTimeImmutable $sentAt = null;

    #[Assert\Valid]
    public FlagsInput $flags;

    /** Message-ID header, with or without angle brackets. */
    #[Assert\Length(max: 998)]
    public ?string $messageId = null;

    #[Assert\Length(max: 998)]
    public ?string $inReplyTo = null;

    /** @var list<string> */
    #[Assert\Count(max: 200)]
    #[Assert\All([new Assert\Length(max: 998)])]
    public array $references = [];

    #[Assert\Length(max: 998)]
    public string $subject = '';

    #[Assert\NotNull]
    #[Assert\Valid]
    public ?AddressInput $from = null;

    /** @var list<AddressInput> */
    #[Assert\Count(max: 1000)]
    #[Assert\Valid]
    public array $to = [];

    /** @var list<AddressInput> */
    #[Assert\Count(max: 1000)]
    #[Assert\Valid]
    public array $cc = [];

    /** @var list<AddressInput> */
    #[Assert\Count(max: 1000)]
    #[Assert\Valid]
    public array $bcc = [];

    /** @var list<AddressInput> */
    #[Assert\Count(max: 100)]
    #[Assert\Valid]
    public array $replyTo = [];

    #[Assert\Length(max: 2000)]
    public string $snippet = '';

    /** Plain text of the body for search: quoted replies dropped, whitespace collapsed, cut by the worker. */
    #[Assert\Length(max: MessageText::MAX_LENGTH)]
    public string $bodyText = '';

    /**
     * Headers that tell automated, bulk and junk mail apart, by lower-cased name: list-unsubscribe,
     * list-unsubscribe-post, list-id, precedence, auto-submitted, feedback-id, x-spam-flag, x-spam-status,
     * authentication-results, x-autoreply and x-autorespond. Missing headers are left out. Values are at most 1000
     * characters, authentication-results at most 8000: the receiving provider's header is long (several DKIM results,
     * ARC) and only meaningful whole, so the worker cuts it at a `;`, never inside a result.
     *
     * @var array<string, string>
     */
    #[Assert\Count(max: 20)]
    #[Assert\All([new Assert\Type('string')])]
    #[Assert\Callback([self::class, 'validateHeaderNames'])]
    public array $headers = [];

    /** The longest header value taken, by name; any other header takes HEADER_MAX_LENGTH. */
    public const array HEADER_MAX_LENGTHS = ['authentication-results' => 8000];
    public const int HEADER_MAX_LENGTH = 1000;

    /** The server flagged the message as junk (IMAP keyword `$Junk`, and no `$NotJunk`). */
    public bool $junk = false;

    /** @var list<AttachmentInput> */
    #[Assert\Count(max: 500)]
    #[Assert\Valid]
    public array $attachments = [];

    /** @var list<CalendarPartInput> */
    #[Assert\Count(max: 5)]
    #[Assert\Valid]
    public array $calendarParts = [];

    /**
     * @param array<mixed> $headers
     */
    public static function validateHeaderNames(array $headers, ExecutionContextInterface $context): void
    {
        foreach (array_keys($headers) as $name) {
            if (!\is_string($name) || 1 !== preg_match('/^[a-z0-9-]{1,64}$/', $name)) {
                $context->buildViolation('Header names are lower-case letters, digits and dashes.')->atPath('headers')->addViolation();

                return;
            }
        }
        foreach ($headers as $name => $value) {
            $max = self::HEADER_MAX_LENGTHS[$name] ?? self::HEADER_MAX_LENGTH;
            if (\is_string($value) && mb_strlen($value) > $max) {
                $context->buildViolation(\sprintf('The header "%s" is at most %d characters.', $name, $max))->atPath('headers['.$name.']')->addViolation();
            }
        }
    }

    public function __construct()
    {
        $this->flags = new FlagsInput();
    }
}
