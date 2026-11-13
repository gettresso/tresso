<?php

declare(strict_types=1);

namespace App\ApiResource;

use ApiPlatform\Metadata\ApiResource;
use ApiPlatform\Metadata\Get;
use ApiPlatform\Metadata\Patch;
use App\ApiResource\Input\Calendar\UpdateMeetingPreferences;
use App\Entity\MeetingPreferences;
use App\Security\Scope;
use App\State\MeetingPreferencesProcessor;
use App\State\MeetingPreferencesProvider;
use Symfony\Component\Serializer\Normalizer\AbstractObjectNormalizer;

/**
 * Which app makes the meeting link of a new event. `defaults` maps a mail account id to `meet`, `teams`, `zoom`, `own`
 * or `none` for the calendars of that account; `defaultOther` is the same for every other calendar (null: none
 * chosen). `ownLink` is the user's own room link (null: none); every event that uses it gets the same link.
 * `addWithGuests` switches the link on when the first guest is added. `disabled` lists the apps the user switched off
 * in Tresso for one account (`meet` for a Google account, `teams` for a Microsoft account). `apps` (read only) are the
 * apps this server can offer.
 *
 * PATCH changes only the fields sent: `ownLink: null` (or leaving it out) keeps the link and `ownLink: ""` clears it.
 * Only Tresso's own apps may change the own link (403 for third-party apps and personal access tokens; every event
 * that uses it would lead guests to the room it names); they may change the other fields.
 * `defaults` and `disabled` replace the whole map or list. Entries for mail accounts that no longer exist are dropped
 * when the preferences are saved, and are not shown before. The own link must be a plain https web address (`App\Calendar\MeetingLinkAddress`,
 * the rule of packages/core); a refused one is named by field, never repeated.
 *
 * App names are plain strings: a client ignores one it does not know (a later server may offer more apps, and a
 * default may name an app that `apps` does not offer on this server).
 */
#[ApiResource(
    shortName: 'MeetingPreferences',
    routePrefix: '/api/v1',
    // Null fields are sent as null, and an empty `defaults` map is {} in JSON, not [].
    normalizationContext: ['skip_null_values' => false, AbstractObjectNormalizer::PRESERVE_EMPTY_OBJECTS => true],
    operations: [
        new Get(
            uriTemplate: '/calendar/meeting-preferences',
            uriVariables: [],
            security: "is_granted('".Scope::ROLE_SETTINGS_READ."')",
            provider: MeetingPreferencesProvider::class,
        ),
        new Patch(
            uriTemplate: '/calendar/meeting-preferences',
            uriVariables: [],
            security: "is_granted('".Scope::ROLE_SETTINGS_WRITE."')",
            input: UpdateMeetingPreferences::class,
            provider: MeetingPreferencesProvider::class,
            processor: MeetingPreferencesProcessor::class,
        ),
    ],
)]
final readonly class MeetingPreferencesResource
{
    /**
     * @param object                                          $defaults mail account id to app or none (an object, so an
     *                                                                  empty one is {} in JSON)
     * @param list<array{app: string, mailAccountId: string}> $disabled
     * @param list<string>                                    $apps
     */
    public function __construct(
        public ?string $ownLink,
        public bool $addWithGuests,
        public object $defaults,
        public ?string $defaultOther,
        public array $disabled,
        public array $apps,
    ) {
    }

    /**
     * @param list<string> $apps       what {@see \App\Calendar\MeetingApps::offered()} answers
     * @param list<string> $accountIds the user's mail accounts: entries of others (deleted since) are left out
     */
    public static function fromEntity(MeetingPreferences $preferences, array $apps, array $accountIds): self
    {
        $accounts = array_flip($accountIds);

        return new self(
            $preferences->getOwnLink(),
            $preferences->addsWithGuests(),
            (object) array_intersect_key($preferences->getDefaults(), $accounts),
            $preferences->getDefaultOther(),
            array_values(array_filter($preferences->getDisabled(), static fn (array $entry): bool => isset($accounts[$entry['mailAccountId']]))),
            $apps,
        );
    }
}
