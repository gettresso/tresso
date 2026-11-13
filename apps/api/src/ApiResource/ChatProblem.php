<?php

declare(strict_types=1);

namespace App\ApiResource;

use ApiPlatform\JsonSchema\SchemaFactory;
use ApiPlatform\Metadata\ApiProperty;
use ApiPlatform\Metadata\Error as ErrorOperation;
use ApiPlatform\Metadata\ErrorResource;
use ApiPlatform\Metadata\Exception\ProblemExceptionInterface;
use App\Outbox\AttachmentLimits;
use Symfony\Component\HttpKernel\Exception\HttpExceptionInterface;
use Symfony\Component\Serializer\Attribute\Groups;
use Symfony\Component\Serializer\Attribute\SerializedName;
use Symfony\Component\WebLink\Link;

/**
 * A refusal of the chat endpoints with a `code` a client acts on beside the problem detail. 409:
 *
 * - `not_the_relay`: the calling desktop does not relay this account (any more); it stops relaying.
 * - `already_going_out`: the reply is being sent or was sent, so it cannot be cancelled.
 * - `id_taken`: another reply has this id; the client makes a new one.
 * - `result_final`: the reply has a result already, or the relay did not claim it; a result is never changed.
 * - `not_failed`: only a reply that failed can be tried again.
 * - `cancelled`: a reply with this id was cancelled or removed; it is never queued again.
 * - `other_number`: a desktop linked to another WhatsApp number than the account's tried to relay an account that holds
 *   chats; its chats would land in the wrong account and the waiting replies would go out from the wrong number.
 * - `not_requested`: the relay sent a file nobody asked for (any more), or reported on one that is stored already.
 * - `not_stored`: the file of this message is not on the server; ask for it first.
 * - `still_sending`: Try again on a reply that may have gone out while its relay's claim still runs; it may still be
 *   on its way, so it is not handed out again yet.
 *
 * 413:
 *
 * - `too_large`: the relay's batch is larger than {@see \App\ApiResource\Input\Chat\RelayMessages::MAX_BYTES}; send fewer messages at once.
 *   For a file: it is larger than {@see \App\Chat\ChatMediaLimits}.
 * - `too_much_waiting`: files uploaded for replies that have not gone out yet take up more than the user may keep
 *   waiting ({@see \App\Chat\ChatUploads}).
 */
#[ErrorResource(
    uriTemplate: '/chat_problems/{id}',
    uriVariables: ['id'],
    openapi: false,
    outputFormats: [
        'jsonld' => ['application/ld+json'],
        'json' => ['application/problem+json', 'application/json'],
    ],
    provider: 'api_platform.state.error_provider',
    shortName: 'ChatProblem',
    description: 'Conflict',
    operations: [
        new ErrorOperation(
            name: '_api_chat_problem_problem',
            outputFormats: ['json' => ['application/problem+json']],
            normalizationContext: [
                SchemaFactory::OPENAPI_DEFINITION_NAME => '',
                'groups' => ['json'],
                'ignored_attributes' => ['trace', 'file', 'line', 'code', 'message', 'traceAsString', 'previous'],
                'skip_null_values' => true,
            ],
        ),
        new ErrorOperation(
            name: '_api_chat_problem_hydra',
            outputFormats: ['jsonld' => ['application/problem+json', 'application/ld+json']],
            links: [new Link(rel: 'http://www.w3.org/ns/json-ld#error', href: 'http://www.w3.org/ns/hydra/error')],
            normalizationContext: [
                SchemaFactory::OPENAPI_DEFINITION_NAME => '',
                'groups' => ['jsonld'],
                'ignored_attributes' => ['trace', 'file', 'line', 'code', 'message', 'traceAsString', 'previous'],
                'skip_null_values' => true,
            ],
        ),
    ],
    graphQlOperations: [],
)]
#[ApiProperty(property: 'traceAsString', hydra: false)]
#[ApiProperty(property: 'string', hydra: false)]
final class ChatProblem extends \RuntimeException implements ProblemExceptionInterface, HttpExceptionInterface
{
    public const string NOT_THE_RELAY = 'not_the_relay';
    public const string ALREADY_GOING_OUT = 'already_going_out';
    public const string ID_TAKEN = 'id_taken';
    public const string RESULT_FINAL = 'result_final';
    public const string NOT_FAILED = 'not_failed';
    public const string CANCELLED = 'cancelled';
    public const string TOO_LARGE = 'too_large';
    public const string OTHER_NUMBER = 'other_number';
    public const string NOT_REQUESTED = 'not_requested';
    public const string NOT_STORED = 'not_stored';
    public const string STILL_SENDING = 'still_sending';
    public const string TOO_MUCH_WAITING = 'too_much_waiting';

    private function __construct(private readonly string $reason, string $detail, private readonly int $status = 409)
    {
        parent::__construct($detail);
    }

    public static function cancelled(): self
    {
        return new self(self::CANCELLED, 'The reply with this id was cancelled or removed; it is not queued again.');
    }

    public static function tooLarge(int $maxBytes): self
    {
        return new self(self::TOO_LARGE, \sprintf('The batch is larger than %d bytes; send fewer messages at once.', $maxBytes), 413);
    }

    public static function fileTooLarge(int $maxBytes): self
    {
        return new self(self::TOO_LARGE, \sprintf('The file is larger than %s.', AttachmentLimits::describe($maxBytes)), 413);
    }

    public static function notRequested(): self
    {
        return new self(self::NOT_REQUESTED, 'Nobody asked for this file, or it is stored already.');
    }

    public static function notStored(): self
    {
        return new self(self::NOT_STORED, 'This file is not on the server. Ask for it first.');
    }

    public static function stillSending(): self
    {
        return new self(self::STILL_SENDING, 'Your Mac may still be sending this reply. Check WhatsApp on your phone, and try again in a few minutes if it did not arrive.');
    }

    public static function tooMuchWaiting(int $maxBytes): self
    {
        return new self(self::TOO_MUCH_WAITING, \sprintf('Files waiting for your Mac take up more than %s. Wait until they are sent, or cancel some, then attach this one again.', AttachmentLimits::describe($maxBytes)), 413);
    }

    public static function otherNumber(): self
    {
        return new self(self::OTHER_NUMBER, 'This desktop is linked to another WhatsApp number than this account holds.');
    }

    public static function notTheRelay(): self
    {
        return new self(self::NOT_THE_RELAY, 'Another device relays this WhatsApp account now.');
    }

    public static function alreadyGoingOut(): self
    {
        return new self(self::ALREADY_GOING_OUT, 'This reply is being sent or was sent; it can no longer be cancelled.');
    }

    public static function idTaken(): self
    {
        return new self(self::ID_TAKEN, 'This id is taken; choose another.');
    }

    public static function resultFinal(): self
    {
        return new self(self::RESULT_FINAL, 'This reply was not claimed by the relay, or has another result already.');
    }

    public static function notFailed(): self
    {
        return new self(self::NOT_FAILED, 'Only a reply that failed can be tried again.');
    }

    /** What the client acts on. */
    #[SerializedName('code')]
    #[Groups(['jsonld', 'json'])]
    #[ApiProperty(writable: false, initializable: false)]
    public function getReason(): string
    {
        return $this->reason;
    }

    public function getId(): string
    {
        return $this->reason;
    }

    #[Groups(['jsonld', 'json'])]
    #[ApiProperty(writable: false, initializable: false)]
    public function getType(): string
    {
        return '/chat_problems/'.$this->reason;
    }

    #[Groups(['jsonld', 'json'])]
    #[ApiProperty(writable: false, initializable: false)]
    public function getTitle(): string
    {
        return 'An error occurred';
    }

    #[Groups(['jsonld', 'json'])]
    #[ApiProperty(writable: false, initializable: false)]
    public function getDetail(): string
    {
        return $this->getMessage();
    }

    #[Groups(['jsonld', 'json'])]
    #[ApiProperty(writable: false, initializable: false)]
    public function getStatus(): int
    {
        return $this->status;
    }

    #[Groups(['jsonld', 'json'])]
    #[ApiProperty(writable: false, initializable: false)]
    public function getInstance(): ?string
    {
        return null;
    }

    public function getStatusCode(): int
    {
        return $this->status;
    }

    /** @return array<string, string> */
    public function getHeaders(): array
    {
        return [];
    }
}
