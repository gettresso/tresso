<?php

declare(strict_types=1);

namespace App\Organization;

use App\Entity\Organization;
use App\Entity\OrganizationMember;
use App\Entity\User;
use App\Enum\OrganizationRole;
use Doctrine\ORM\EntityManagerInterface;
use Psr\Clock\ClockInterface;

/**
 * Makes the personal organization a new user owns, so a subscription always has an organization to belong to.
 */
final readonly class PersonalOrganizations
{
    public function __construct(
        private EntityManagerInterface $entityManager,
        private ClockInterface $clock,
    ) {
    }

    public function create(User $user): Organization
    {
        $now = $this->clock->now();
        $organization = Organization::personal($user, $now);
        $this->entityManager->persist($organization);
        $this->entityManager->persist(new OrganizationMember($organization, $user, OrganizationRole::Owner, $now));

        return $organization;
    }
}
