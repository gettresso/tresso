<?php

declare(strict_types=1);

namespace App\Chat;

use ApiPlatform\Validator\Exception\ValidationException;
use App\ApiResource\ChatProblem;
use App\Outbox\OutgoingAttachment;
use Symfony\Component\HttpFoundation\Request;
use Symfony\Component\HttpKernel\Exception\BadRequestHttpException;
use Symfony\Component\Mime\MimeTypes;
use Symfony\Component\Validator\ConstraintViolation;
use Symfony\Component\Validator\ConstraintViolationList;

/**
 * Reads a WhatsApp file sent as the raw body of a PUT (the relay's download, a browser's or phone's upload) into a
 * temporary file, never into memory, hashing it on the way. A body is refused as too large before it is read when its
 * length says so, and is read no further than one byte past the limit otherwise (413 `too_large`). A PUT, not a POST
 * form: PHP's form limits (post_max_size) do not apply to it, so a file up to {@see ChatMediaLimits} arrives whole.
 *
 * `X-Content-SHA256` (hex), when sent, must match what arrived (422); the relay always sends it, for the SHA-256 the
 * bridge's store holds.
 */
final readonly class ChatFileBody
{
    public const string SHA256_HEADER = 'X-Content-SHA256';

    /** What the temporary files are called, so a sweep finds those a killed worker left ({@see SweepChatMediaHandler}). */
    public const string TEMPORARY_PREFIX = 'tresso-chat-';

    private const int CHUNK = 1024 * 1024;

    public function __construct(private ChatMediaLimits $limits)
    {
    }

    public function receive(Request $request, bool $hashRequired): ReceivedChatFile
    {
        $max = $this->limits->maxFileBytes;
        $announced = $request->headers->get('Content-Length');
        if (is_numeric($announced) && (int) $announced > $max) {
            throw ChatProblem::fileTooLarge($max);
        }
        $claimed = $request->headers->get(self::SHA256_HEADER);
        $claimed = null === $claimed ? null : strtolower(trim($claimed));
        if (null !== $claimed && 1 !== preg_match('/^[0-9a-f]{64}$/', $claimed)) {
            throw self::invalid('The SHA-256 is not 64 hex digits.');
        }
        if (null === $claimed && $hashRequired) {
            throw self::invalid(\sprintf('Send the file\'s SHA-256 in %s.', self::SHA256_HEADER));
        }

        $path = tempnam(sys_get_temp_dir(), self::TEMPORARY_PREFIX);
        if (false === $path) {
            throw new \RuntimeException('No temporary file for an upload.');
        }
        try {
            $out = fopen($path, 'wb') ?: throw new \RuntimeException('The temporary file cannot be written.');
            $in = $request->getContent(true);
            $hash = hash_init('sha256');
            $size = 0;
            try {
                while (!feof($in)) {
                    $chunk = fread($in, self::CHUNK);
                    if (false === $chunk) {
                        throw new BadRequestHttpException('The body could not be read.');
                    }
                    $size += \strlen($chunk);
                    if ($size > $max) {
                        throw ChatProblem::fileTooLarge($max);
                    }
                    hash_update($hash, $chunk);
                    if (false === fwrite($out, $chunk)) {
                        throw new \RuntimeException('The temporary file cannot be written.');
                    }
                }
            } finally {
                fclose($out);
            }
            if (0 === $size) {
                throw self::invalid('The file is empty.');
            }
            $sha256 = hash_final($hash);
            if (null !== $claimed && !hash_equals($claimed, $sha256)) {
                throw self::invalid('The file that arrived does not match its SHA-256. Send it again.');
            }

            return new ReceivedChatFile($path, $size, $sha256, self::contentType($path, $request->headers->get('Content-Type')));
        } catch (\Throwable $exception) {
            @unlink($path);
            throw $exception;
        }
    }

    /**
     * What the content is, from the file itself where it can tell; otherwise what the sender said, if it is a well-formed
     * type other than the transport's own (`application/octet-stream`).
     */
    private static function contentType(string $path, ?string $declared): string
    {
        $guessed = MimeTypes::getDefault()->guessMimeType($path);
        foreach ([$guessed, null === $declared ? null : trim(explode(';', $declared)[0])] as $candidate) {
            if (null !== $candidate && 'application/octet-stream' !== strtolower($candidate) && 1 === preg_match(OutgoingAttachment::CONTENT_TYPE, $candidate)) {
                return strtolower($candidate);
            }
        }

        return 'application/octet-stream';
    }

    private static function invalid(string $message): ValidationException
    {
        return new ValidationException(new ConstraintViolationList([new ConstraintViolation($message, null, [], null, 'file', null)]));
    }
}
