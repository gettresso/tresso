<?php

declare(strict_types=1);

namespace App\Service;

use App\Calendar\LocalCalendars;
use App\Classification\BuiltinSmartInboxes;
use App\Entity\DailyBriefSettings;
use App\Entity\NotificationPreferences;
use App\Entity\User;
use App\Entity\UserSettings;
use App\Notification\ReminderRules;
use App\Organization\PersonalOrganizations;
use App\Security\Crypto\UserKeys;
use Doctrine\ORM\EntityManagerInterface;
use Psr\Clock\ClockInterface;
use Symfony\Component\PasswordHasher\Hasher\UserPasswordHasherInterface;

/**
 * Creates a user together with everything a new account needs: settings, the built-in smart inboxes, the local
 * Tresso calendar, the notification preferences with the default reminder rules, the daily brief settings, and the
 * personal organization a subscription belongs to.
 */
final readonly class UserProvisioner
{
    public function __construct(
        private EntityManagerInterface $entityManager,
        private UserPasswordHasherInterface $passwordHasher,
        private BuiltinSmartInboxes $builtinSmartInboxes,
        private ReminderRules $reminderRules,
        private ClockInterface $clock,
        private UserKeys $keys,
        private PersonalOrganizations $personalOrganizations,
    ) {
    }

    public function provision(string $email, string $displayName, #[\SensitiveParameter] string $plainPassword): User
    {
        $user = new User($email, $displayName);
        $user->setPassword($this->passwordHasher->hashPassword($user, $plainPassword));
        $this->entityManager->persist($user);
        $this->entityManager->persist(new UserSettings($user));
        $preferences = new NotificationPreferences($user);
        $this->entityManager->persist($preferences);
        $this->reminderRules->createDefaults($user);
        $this->entityManager->persist(LocalCalendars::create($user));
        $this->entityManager->persist(new DailyBriefSettings($user, $preferences->getTimeZone(), $this->clock->now()));
        $this->personalOrganizations->create($user);

        $this->builtinSmartInboxes->ensure($user);

        $this->entityManager->flush();
        $this->keys->ensure($user->getId());
        // A new user has no data yet on any other key: nothing for the background re-encryption.
        $this->entityManager->getConnection()->executeStatement('UPDATE app_user SET data_key_version = 1 WHERE id = :id', ['id' => $user->getId()->toRfc4122()]);

        return $user;
    }
}
