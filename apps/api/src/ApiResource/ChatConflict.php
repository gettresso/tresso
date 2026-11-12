<?php

declare(strict_types=1);

namespace App\ApiResource;

use ApiPlatform\JsonSchema\SchemaFactory;
use ApiPlatform\Metadata\ApiProperty;
use ApiPlatform\Metadata\Error as ErrorOperation;
use ApiPlatform\Metadata\ErrorResource;
use ApiPlatform\Metadata\Exception\ProblemExceptionInterface;
use Symfony\Component\HttpKernel\Exception\HttpExceptionInterface;
use Symfony\Component\Serializer\Attribute\Groups;
use Symfony\Component\Serializer\Attribute\SerializedName;
use Symfony\Component\WebLink\Link;

/**
 * A 409 of the chat endpoints, with a `code` a client acts on beside the problem detail:
 *
 * - `not_the_relay`: the calling desktop does not relay this account (any more); it stops relaying.
 * - `already_going_out`: the reply is being sent or was sent, so it cannot be cancelled.
 * - `id_taken`: another reply has this id; the client makes a new one.
 * - `result_final`: the reply has a result already, or the relay did not claim it; a result is never changed.
 * - `not_failed`: only a reply that failed can be tried again.
 */
#[ErrorResource(
    uriTemplate: '/chat_conflicts/{id}',
    status: 409,
    uriVariables: ['id'],
    openapi: false,
    outputFormats: [
        'jsonld' => ['application/ld+json'],
        'json' => ['application/problem+json', 'application/json'],
    ],
    provider: 'api_platform.state.error_provider',
    shortName: 'ChatConflict',
    description: 'Conflict',
    operations: [
        new ErrorOperation(
            name: '_api_chat_conflict_problem',
            outputFormats: ['json' => ['application/problem+json']],
            normalizationContext: [
                SchemaFactory::OPENAPI_DEFINITION_NAME => '',
                'groups' => ['json'],
                'ignored_attributes' => ['trace', 'file', 'line', 'code', 'message', 'traceAsString', 'previous'],
                'skip_null_values' => true,
            ],
        ),
        new ErrorOperation(
            name: '_api_chat_conflict_hydra',
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
final class ChatConflict extends \RuntimeException implements ProblemExceptionInterface, HttpExceptionInterface
{
    public const string NOT_THE_RELAY = 'not_the_relay';
    public const string ALREADY_GOING_OUT = 'already_going_out';
    public const string ID_TAKEN = 'id_taken';
    public const string RESULT_FINAL = 'result_final';
    public const string NOT_FAILED = 'not_failed';

    private function __construct(private readonly string $reason, string $detail)
    {
        parent::__construct($detail);
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
        return '/chat_conflicts/'.$this->reason;
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
        return 409;
    }

    #[Groups(['jsonld', 'json'])]
    #[ApiProperty(writable: false, initializable: false)]
    public function getInstance(): ?string
    {
        return null;
    }

    public function getStatusCode(): int
    {
        return 409;
    }

    /** @return array<string, string> */
    public function getHeaders(): array
    {
        return [];
    }
}
