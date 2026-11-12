<?php

declare(strict_types=1);

namespace App\Chat;

use ApiPlatform\Validator\Exception\ValidationException;
use App\ApiResource\ChatProblem;
use Symfony\Component\HttpFoundation\Request;
use Symfony\Component\HttpKernel\Exception\BadRequestHttpException;
use Symfony\Component\Serializer\Exception\ExceptionInterface as SerializerExceptionInterface;
use Symfony\Component\Serializer\SerializerInterface;
use Symfony\Component\Validator\Validator\ValidatorInterface;

/**
 * Reads the JSON body of a chat request into its input class and validates it, for the operations that do not let API
 * Platform do that:
 *
 * - a reply names its own `id`, which API Platform takes for an update of an existing item;
 * - a relay batch is checked for its size in bytes first, so a batch too large is answered 413 `too_large` (the relay
 *   then sends fewer messages at once) before anything of it is decoded.
 *
 * Nothing of the body is repeated in an error: a 422 names the fields only.
 */
final readonly class ChatRequestBody
{
    public function __construct(
        private SerializerInterface $serializer,
        private ValidatorInterface $validator,
    ) {
    }

    /**
     * @template T of object
     *
     * @param class-string<T> $class
     *
     * @return T
     */
    public function read(Request $request, string $class, int $maxBytes): object
    {
        // The announced length first: above PHP's post_max_size the body never reaches the app (PHP drops it), and a
        // body that is too large is refused without being read.
        $announced = $request->headers->get('Content-Length');
        if (is_numeric($announced) && (int) $announced > $maxBytes) {
            throw ChatProblem::tooLarge($maxBytes);
        }
        // Read no more than one byte past the limit, also for a body without a length (chunked).
        $content = stream_get_contents($request->getContent(true), $maxBytes + 1);
        if (false === $content) {
            throw new BadRequestHttpException('The body could not be read.');
        }
        if (\strlen($content) > $maxBytes) {
            throw ChatProblem::tooLarge($maxBytes);
        }
        try {
            $input = $this->serializer->deserialize($content, $class, 'json');
        } catch (SerializerExceptionInterface) {
            throw new BadRequestHttpException('The body is not valid JSON of the expected shape.');
        }
        if (!$input instanceof $class) {
            throw new BadRequestHttpException('The body is not valid JSON of the expected shape.');
        }
        $violations = $this->validator->validate($input);
        if (\count($violations) > 0) {
            throw new ValidationException($violations);
        }

        return $input;
    }
}
