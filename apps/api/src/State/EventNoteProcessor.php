<?php

declare(strict_types=1);

namespace App\State;

use ApiPlatform\Metadata\Operation;
use ApiPlatform\State\ProcessorInterface;
use App\ApiResource\EventNoteResource;
use App\ApiResource\Input\Calendar\EventNoteInput;
use App\Entity\CalendarEvent;
use App\Entity\EventNote;
use App\Repository\CalendarEventRepository;
use App\Repository\EventNoteRepository;
use App\Security\CurrentUser;
use Doctrine\ORM\EntityManagerInterface;
use Symfony\Component\HttpKernel\Exception\NotFoundHttpException;
use Symfony\Component\HttpKernel\Exception\UnprocessableEntityHttpException;

/**
 * @implements ProcessorInterface<EventNoteInput, EventNoteResource>
 */
final readonly class EventNoteProcessor implements ProcessorInterface
{
    public function __construct(
        private EntityManagerInterface $entityManager,
        private CalendarEventRepository $events,
        private EventNoteRepository $notes,
        private CurrentUser $currentUser,
    ) {
    }

    public function process(mixed $data, Operation $operation, array $uriVariables = [], array $context = []): EventNoteResource
    {
        $id = $uriVariables['id'] ?? null;
        $event = \is_string($id) ? $this->events->findOneOwnedBy($this->currentUser->get(), $id) : null;
        if (!$event instanceof CalendarEvent) {
            throw new NotFoundHttpException('Event not found.');
        }
        $key = $data->recurrenceId ?? $event->getRecurrenceKey();
        $text = rtrim($data->text);

        $this->entityManager->wrapInTransaction(function () use ($event, $key, $text): void {
            $note = $this->notes->findFor($event, $key);
            $length = mb_strlen($text);
            if ($length > EventNote::MAX_LENGTH && $length > mb_strlen($note?->getText() ?? '')) {
                throw new UnprocessableEntityHttpException(\sprintf('A note holds at most %d characters.', EventNote::MAX_LENGTH));
            }
            if ('' === $text) {
                if (null !== $note) {
                    $this->entityManager->remove($note);
                }
            } else {
                if (null === $note) {
                    $note = new EventNote($event, $key);
                    $this->entityManager->persist($note);
                }
                $note->write($text);
            }
            $this->entityManager->flush();
        });

        return new EventNoteResource($event->getId()->toRfc4122(), '' === $key ? null : $key, $text);
    }
}
