<?php

declare(strict_types=1);

namespace App\Calendar\Assistant;

/**
 * What to know before a meeting: who comes, the recent conversations with them, and (from an AI version) a summary.
 *
 * @phpstan-type BriefPerson array{address: string, name: ?string, response: string}
 * @phpstan-type BriefThread array{threadId: string, mailAccountId: string, subject: string, lastMessageAt: string, messageCount: int}
 */
final readonly class MeetingBrief
{
    /**
     * @param list<BriefPerson> $people
     * @param list<BriefThread> $threads
     */
    public function __construct(
        public array $people,
        public array $threads,
        /** A written summary; null when nobody writes one (without an AI version). */
        public ?string $summary,
    ) {
    }

    /** One or two lines for a notification. */
    public function headline(): string
    {
        if (null !== $this->summary && '' !== trim($this->summary)) {
            return mb_substr(trim($this->summary), 0, 300);
        }
        $names = array_map(static fn (array $person): string => $person['name'] ?? $person['address'], \array_slice($this->people, 0, 3));
        $with = match (true) {
            [] === $names => 'No one else is invited.',
            \count($this->people) > 3 => \sprintf('With %s and %d others.', implode(', ', $names), \count($this->people) - 3),
            1 === \count($names) => \sprintf('With %s.', $names[0]),
            default => \sprintf('With %s and %s.', implode(', ', \array_slice($names, 0, -1)), $names[\count($names) - 1]),
        };
        if ([] === $this->threads) {
            return $with;
        }
        $subjects = array_map(static fn (array $thread): string => '' === $thread['subject'] ? '(no subject)' : $thread['subject'], \array_slice($this->threads, 0, 2));

        return \sprintf('%s Recent: %s.', $with, implode('; ', $subjects));
    }
}
