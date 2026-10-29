<?php

declare(strict_types=1);

namespace App\State;

use ApiPlatform\Metadata\Operation;
use ApiPlatform\State\ProviderInterface;
use App\ApiResource\BillingOrganization;
use App\ApiResource\BillingResource;
use App\Billing\BillingSettings;
use App\Billing\Entitlements;
use App\Billing\Subscriptions;
use App\Entity\OrganizationMember;
use App\Enum\OrganizationRole;
use App\Repository\OrganizationMemberRepository;
use App\Security\CurrentUser;
use Psr\Clock\ClockInterface;

/**
 * @implements ProviderInterface<BillingResource>
 */
final readonly class BillingProvider implements ProviderInterface
{
    public function __construct(
        private CurrentUser $currentUser,
        private BillingSettings $settings,
        private Entitlements $entitlements,
        private Subscriptions $subscriptions,
        private OrganizationMemberRepository $members,
        private ClockInterface $clock,
    ) {
    }

    public function provide(Operation $operation, array $uriVariables = [], array $context = []): BillingResource
    {
        $user = $this->currentUser->get();
        if (!$this->settings->enabled) {
            return new BillingResource($user->getId()->toRfc4122(), false, true, [], []);
        }

        $memberships = $this->members->findOfUser($user);
        $seats = $this->members->countPerOrganization(array_map(static fn (OrganizationMember $m) => $m->getOrganization()->getId(), $memberships));
        $now = $this->clock->now();
        $organizations = [];
        foreach ($memberships as $membership) {
            $organization = $membership->getOrganization();
            $subscription = $this->subscriptions->of($organization);
            $organizations[] = new BillingOrganization(
                $organization->getId()->toRfc4122(),
                $organization->getName(),
                $organization->isPersonalOf($user),
                $subscription->getStatus()->value,
                $subscription->allowsAccessAt($now),
                $subscription->getTrialEndsAt(),
                $subscription->getCurrentPeriodEnd(),
                $subscription->getSeats() > 0 ? $subscription->getSeats() : ($seats[$organization->getId()->toRfc4122()] ?? 1),
                \in_array($membership->getRole(), [OrganizationRole::Owner, OrganizationRole::Admin], true),
            );
        }

        return new BillingResource(
            $user->getId()->toRfc4122(),
            true,
            $this->entitlements->allows($user->getId()),
            array_keys($this->settings->prices()),
            $organizations,
        );
    }
}
