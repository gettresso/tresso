<?php

declare(strict_types=1);

namespace App\State;

use ApiPlatform\Metadata\Operation;
use ApiPlatform\State\ProcessorInterface;
use ApiPlatform\Validator\Exception\ValidationException;
use App\ApiResource\Input\Calendar\UpdateMeetingPreferences;
use App\ApiResource\MeetingPreferencesResource;
use App\Calendar\MeetingApps;
use App\Calendar\MeetingLinkAddress;
use App\Entity\MailAccount;
use App\Entity\MeetingPreferences;
use App\Enum\MailProvider;
use App\Repository\MailAccountRepository;
use App\Repository\MeetingPreferencesRepository;
use App\Security\CurrentUser;
use App\Security\FirstPartyClients;
use Doctrine\ORM\EntityManagerInterface;
use Symfony\Bundle\SecurityBundle\Security;
use Symfony\Component\HttpKernel\Exception\AccessDeniedHttpException;
use Symfony\Component\Uid\Uuid;
use Symfony\Component\Validator\ConstraintViolation;
use Symfony\Component\Validator\ConstraintViolationList;

/**
 * Changes the user's meeting preferences, creating them on the first change (also when two first changes come at
 * once). Only Tresso's own apps may change the own link. Every mail account named in `defaults` and `disabled` must be the user's; entries of accounts that are gone
 * are dropped on every save. A violation names the field and never repeats a link.
 *
 * @implements ProcessorInterface<UpdateMeetingPreferences, MeetingPreferencesResource>
 */
final readonly class MeetingPreferencesProcessor implements ProcessorInterface
{
    private const string NO_ACCOUNT = 'Use the id of one of your mail accounts.';
    private const string NOT_A_DEFAULT = 'Use meet, teams, zoom, own or none.';
    private const string NOT_AN_ENTRY = 'Each entry has an app (meet or teams) and a mailAccountId.';
    private const string MEET_NEEDS_GOOGLE = 'Google Meet can only be switched off for a Google account.';
    private const string OWN_APPS_ONLY = 'Only Tresso\'s own apps can change your own meeting link. Change it in Settings, Meeting apps.';
    private const string TEAMS_NEEDS_MICROSOFT = 'Microsoft Teams can only be switched off for a Microsoft account.';

    public function __construct(
        private MeetingPreferencesRepository $preferences,
        private MailAccountRepository $accounts,
        private MeetingApps $apps,
        private CurrentUser $currentUser,
        private EntityManagerInterface $entityManager,
        private Security $security,
    ) {
    }

    public function process(mixed $data, Operation $operation, array $uriVariables = [], array $context = []): MeetingPreferencesResource
    {
        return $this->entityManager->wrapInTransaction(function () use ($data): MeetingPreferencesResource {
            $user = $this->currentUser->get();
            $accounts = [];
            foreach ($this->accounts->findOwnedBy($user) as $account) {
                $accounts[$account->getId()->toRfc4122()] = $account;
            }

            $violations = new ConstraintViolationList();
            $ownLink = self::ownLink($data->ownLink, $violations);
            $defaults = null === $data->defaults ? null : self::defaults($data->defaults, $accounts, $violations);
            $disabled = null === $data->disabled ? null : self::disabled($data->disabled, $accounts, $violations);
            if (\count($violations) > 0) {
                throw new ValidationException($violations);
            }

            $preferences = $this->preferences->lockForUser($user);
            if (null !== $ownLink && ('' === $ownLink ? null : $ownLink) !== $preferences->getOwnLink() && !$this->security->isGranted(FirstPartyClients::ATTRIBUTE)) {
                // Every event that uses the own link leads its guests to that room: only the user, in Tresso, sets it.
                throw new AccessDeniedHttpException(self::OWN_APPS_ONLY);
            }
            if (null !== $ownLink) {
                $preferences->setOwnLink('' === $ownLink ? null : $ownLink);
            }
            if (null !== $data->addWithGuests) {
                $preferences->setAddWithGuests($data->addWithGuests);
            }
            if (null !== $data->defaultOther) {
                $preferences->setDefaultOther($data->defaultOther);
            }
            self::keepAccounts($preferences, $defaults ?? $preferences->getDefaults(), $disabled ?? $preferences->getDisabled(), $accounts);
            $this->entityManager->flush();

            return MeetingPreferencesResource::fromEntity($preferences, $this->apps->offered(), array_keys($accounts));
        });
    }

    /**
     * The link to keep, "" to clear it, or null to leave it as it is (also when it is not accepted).
     */
    private static function ownLink(#[\SensitiveParameter] ?string $value, ConstraintViolationList $violations): ?string
    {
        if (null === $value || '' === $value) {
            return $value;
        }
        $violation = MeetingLinkAddress::violation($value);
        if (null !== $violation) {
            // No invalid value on the violation: the link is a capability and stays out of every error.
            $violations->add(new ConstraintViolation($violation, null, [], null, 'ownLink', null));

            return null;
        }

        return $value;
    }

    /**
     * @param array<mixed>               $value
     * @param array<string, MailAccount> $accounts the user's, by id
     *
     * @return array<string, string>
     */
    private static function defaults(array $value, array $accounts, ConstraintViolationList $violations): array
    {
        $defaults = [];
        foreach ($value as $id => $app) {
            $account = self::account($id, $accounts);
            if (null === $account) {
                $violations->add(new ConstraintViolation(self::NO_ACCOUNT, null, [], null, 'defaults', null));
                continue;
            }
            if (!\is_string($app) || !\in_array($app, MeetingPreferences::DEFAULTS, true)) {
                $violations->add(new ConstraintViolation(self::NOT_A_DEFAULT, null, [], null, 'defaults', null));
                continue;
            }
            $defaults[$account->getId()->toRfc4122()] = $app;
        }

        return $defaults;
    }

    /**
     * @param array<mixed>               $value
     * @param array<string, MailAccount> $accounts the user's, by id
     *
     * @return list<array{app: string, mailAccountId: string}>
     */
    private static function disabled(array $value, array $accounts, ConstraintViolationList $violations): array
    {
        $disabled = [];
        foreach ($value as $entry) {
            $app = \is_array($entry) ? ($entry['app'] ?? null) : null;
            $id = \is_array($entry) ? ($entry['mailAccountId'] ?? null) : null;
            if (!\is_string($app) || !\in_array($app, MeetingPreferences::SWITCHABLE, true) || !\is_string($id) || \count($entry) > 2) {
                $violations->add(new ConstraintViolation(self::NOT_AN_ENTRY, null, [], null, 'disabled', null));
                continue;
            }
            $account = self::account($id, $accounts);
            if (null === $account) {
                $violations->add(new ConstraintViolation(self::NO_ACCOUNT, null, [], null, 'disabled', null));
                continue;
            }
            $provider = $account->getProvider();
            if ('meet' === $app && MailProvider::Gmail !== $provider) {
                $violations->add(new ConstraintViolation(self::MEET_NEEDS_GOOGLE, null, [], null, 'disabled', null));
                continue;
            }
            if ('teams' === $app && MailProvider::Microsoft !== $provider) {
                $violations->add(new ConstraintViolation(self::TEAMS_NEEDS_MICROSOFT, null, [], null, 'disabled', null));
                continue;
            }
            $item = ['app' => $app, 'mailAccountId' => $account->getId()->toRfc4122()];
            if (!\in_array($item, $disabled, true)) {
                $disabled[] = $item;
            }
        }

        return $disabled;
    }

    /**
     * Stores the map and the list without the entries of mail accounts the user no longer has.
     *
     * @param array<string, string>                           $defaults
     * @param list<array{app: string, mailAccountId: string}> $disabled
     * @param array<string, MailAccount>                      $accounts the user's, by id
     */
    private static function keepAccounts(MeetingPreferences $preferences, array $defaults, array $disabled, array $accounts): void
    {
        $defaults = array_intersect_key($defaults, $accounts);
        $disabled = array_values(array_filter($disabled, static fn (array $entry): bool => isset($accounts[$entry['mailAccountId']])));
        if ($defaults !== $preferences->getDefaults()) {
            $preferences->setDefaults($defaults);
        }
        if ($disabled !== $preferences->getDisabled()) {
            $preferences->setDisabled($disabled);
        }
    }

    /**
     * @param array<string, MailAccount> $accounts the user's, by id
     */
    private static function account(mixed $id, array $accounts): ?MailAccount
    {
        if (!\is_string($id) || !Uuid::isValid($id)) {
            return null;
        }

        return $accounts[Uuid::fromString($id)->toRfc4122()] ?? null;
    }
}
