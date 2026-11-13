<?php

declare(strict_types=1);

namespace App\State;

use ApiPlatform\Metadata\Operation;
use ApiPlatform\State\ProcessorInterface;
use ApiPlatform\Validator\Exception\ValidationException;
use App\ApiResource\Output\Chat\RelayMediaOutput;
use App\Chat\ChatFileBody;
use App\Chat\ChatMedia;
use App\Chat\ChatTime;
use App\Security\CurrentUser;
use Doctrine\ORM\EntityManagerInterface;
use Symfony\Component\HttpFoundation\Request;
use Symfony\Component\Uid\Uuid;
use Symfony\Component\Validator\ConstraintViolation;
use Symfony\Component\Validator\ConstraintViolationList;

/**
 * Takes a file the relay brought ({@see ChatMedia::store()}): the raw body of a PUT, its device in `X-Device-Id` and the
 * SHA-256 the bridge's store holds in `X-Content-SHA256`, both required.
 *
 * @implements ProcessorInterface<null, RelayMediaOutput>
 */
final readonly class ChatMediaUploadProcessor implements ProcessorInterface
{
    public const string DEVICE_HEADER = 'X-Device-Id';

    public function __construct(
        private ChatMedia $media,
        private ChatFileBody $body,
        private CurrentUser $currentUser,
        private EntityManagerInterface $entityManager,
    ) {
    }

    public function process(mixed $data, Operation $operation, array $uriVariables = [], array $context = []): RelayMediaOutput
    {
        $request = $context['request'] ?? null;
        if (!$request instanceof Request) {
            throw new \LogicException('A file upload needs the request.');
        }
        $deviceId = (string) $request->headers->get(self::DEVICE_HEADER, '');
        if (!Uuid::isValid($deviceId)) {
            throw new ValidationException(new ConstraintViolationList([new ConstraintViolation(\sprintf('Name the relaying device in %s.', self::DEVICE_HEADER), null, [], null, 'deviceId', null)]));
        }
        $user = $this->currentUser->get();
        $file = $this->body->receive($request, true);
        try {
            $message = $this->media->store($user, $uriVariables['accountId'] ?? null, $uriVariables['messageId'] ?? null, $deviceId, $file, ChatTime::stored(new \DateTimeImmutable()));
        } finally {
            $file->discard();
        }
        $output = new RelayMediaOutput($message->getId()->toRfc4122(), $message->getMediaState()->value ?? '', $message->getMediaError()?->value);
        $this->entityManager->clear();

        return $output;
    }
}
