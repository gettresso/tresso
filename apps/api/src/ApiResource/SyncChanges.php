<?php

declare(strict_types=1);

namespace App\ApiResource;

use ApiPlatform\Metadata\ApiResource;
use ApiPlatform\Metadata\Get;
use ApiPlatform\Metadata\QueryParameter;
use App\Security\Scope;
use App\State\SyncChangesProvider;
use Symfony\Component\Validator\Constraints as Assert;

/**
 * Everything that changed for the signed-in user after a change number: the client's way to keep a local copy.
 *
 * Start with since=0, store the returned cursor, and call again with since=cursor while hasMore is true. A page never
 * splits the changes of one change number. "latest" is the newest change number handed out to the user when the page
 * was read: with "since" and "cursor" it tells a client how far behind it is (how much of a pull is left). It is never
 * below "cursor", but may stay above the last cursor a pull reaches, so a pull ends at hasMore false, not at "latest".
 * "deleted" lists removed entities; a removed mail account means everything under it (folders, threads, messages,
 * outgoing messages, calendars) is gone too, and a removed calendar means its events are gone. Calendar events come as
 * stored (series with their rule, overrides with their recurrenceId), for series that end after two years ago.
 * Notifications come once delivered (from the last week), so every device can show and clear them; event notes are the
 * user's private notes. A todo whose email is gone changes too, without the link; clients also treat a link to an email
 * they do not have as no link. Mail notifications (new mail that needs the user) come once delivered, from the last
 * week, so the desktop app shows them.
 *
 * Each list needs the scope of its own endpoints (SyncChangesProvider::SCOPES); without it the list and its removals
 * come empty, while the cursor stays the same for every token.
 */
#[ApiResource(
    shortName: 'SyncChanges',
    routePrefix: '/api/v1',
    operations: [
        new Get(
            uriTemplate: '/sync/changes',
            uriVariables: [],
            security: "is_granted('".Scope::ROLE_MAIL_READ."')",
            provider: SyncChangesProvider::class,
            normalizationContext: ['skip_null_values' => false],
            parameters: [
                'since' => new QueryParameter(
                    schema: ['type' => 'integer', 'minimum' => 0, 'default' => 0],
                    description: 'The cursor from the previous response; 0 for a full sync.',
                    constraints: [new Assert\Regex('/^\d{1,18}$/', message: 'since must be a non-negative integer.')],
                ),
                'limit' => new QueryParameter(
                    schema: ['type' => 'integer', 'minimum' => 1, 'maximum' => 2000, 'default' => 500],
                    description: 'Soft limit on entities per page; a page always contains complete change numbers.',
                    constraints: [new Assert\Regex('/^\d{1,4}$/', message: 'limit must be an integer.'), new Assert\Range(min: 1, max: 2000)],
                ),
            ],
        ),
    ],
)]
final readonly class SyncChanges
{
    /**
     * @param int                                       $latest       the newest change number of the user, never below the cursor
     * @param list<array<string, mixed>>                $mailAccounts
     * @param list<array<string, mixed>>                $folders
     * @param list<array<string, mixed>>                $threads
     * @param list<array<string, mixed>>                $messages
     * @param list<array<string, mixed>>                $outgoingMessages
     * @param list<array<string, mixed>>                $signatures
     * @param list<array<string, mixed>>                $drafts
     * @param list<array<string, mixed>>                $smartInboxes
     * @param list<array<string, mixed>>                $calendars
     * @param list<array<string, mixed>>                $calendarEvents
     * @param list<array<string, mixed>>                $notifications
     * @param list<array<string, mixed>>                $eventNotes
     * @param list<array<string, mixed>>                $todos
     * @param list<array<string, mixed>>                $mailNotifications
     * @param list<array<string, mixed>>                $unsubscriptions
     * @param list<array<string, mixed>>                $handOvers
     * @param list<array<string, mixed>>                $dailyBriefs
     * @param list<array{type: string, id: string}> $deleted
     */
    public function __construct(
        public int $cursor,
        public bool $hasMore,
        public int $latest,
        public array $mailAccounts,
        public array $folders,
        public array $threads,
        public array $messages,
        public array $outgoingMessages,
        public array $signatures,
        public array $drafts,
        public array $smartInboxes,
        public array $calendars,
        public array $calendarEvents,
        public array $notifications,
        public array $eventNotes,
        public array $todos,
        public array $mailNotifications,
        public array $unsubscriptions,
        public array $handOvers,
        public array $dailyBriefs,
        public array $deleted,
    ) {
    }
}
