<?php

declare(strict_types=1);

namespace App\State;

use ApiPlatform\Metadata\Operation;
use ApiPlatform\State\ProcessorInterface;
use App\ApiResource\BillingPage;
use App\ApiResource\Input\Billing\BillingCheckoutInput;
use App\ApiResource\Input\Billing\BillingPortalInput;
use App\Billing\BillingSettings;
use App\Billing\Stripe\StripeException;
use App\Billing\Subscriptions;
use App\Entity\OrganizationMember;
use App\Enum\OrganizationRole;
use App\Repository\OrganizationMemberRepository;
use App\Security\CurrentUser;
use Symfony\Component\HttpKernel\Exception\AccessDeniedHttpException;
use Symfony\Component\HttpKernel\Exception\NotFoundHttpException;
use Symfony\Component\HttpKernel\Exception\ServiceUnavailableHttpException;
use Symfony\Component\HttpKernel\Exception\UnprocessableEntityHttpException;
use Symfony\Component\Uid\Uuid;

/**
 * Opens Stripe Checkout or the billing portal for an organization the user owns or administers.
 *
 * @implements ProcessorInterface<BillingCheckoutInput|BillingPortalInput, BillingPage>
 */
final readonly class BillingProcessor implements ProcessorInterface
{
    public function __construct(
        private CurrentUser $currentUser,
        private BillingSettings $settings,
        private Subscriptions $subscriptions,
        private OrganizationMemberRepository $members,
    ) {
    }

    public function process(mixed $data, Operation $operation, array $uriVariables = [], array $context = []): BillingPage
    {
        if (!$this->settings->enabled) {
            throw new NotFoundHttpException('This server does not bill.');
        }
        $user = $this->currentUser->get();
        $membership = $this->members->findOneBy(['user' => $user, 'organization' => Uuid::fromString($data->organizationId)]);
        if (!$membership instanceof OrganizationMember) {
            throw new NotFoundHttpException('Organization not found.');
        }
        if (!\in_array($membership->getRole(), [OrganizationRole::Owner, OrganizationRole::Admin], true)) {
            throw new AccessDeniedHttpException('Only an owner or admin manages the subscription.');
        }
        $organization = $membership->getOrganization();
        $subscription = $this->subscriptions->of($organization);

        try {
            if ($data instanceof BillingCheckoutInput) {
                $price = $this->settings->prices()[$data->plan] ?? null;
                if (null === $price) {
                    throw new UnprocessableEntityHttpException(\sprintf('This server does not sell the %s plan.', $data->plan));
                }

                return new BillingPage($this->subscriptions->checkout($subscription, $user, $price));
            }
            if (null === $subscription->getStripeCustomerId()) {
                throw new UnprocessableEntityHttpException('There is no subscription to manage yet; start one first.');
            }

            return new BillingPage($this->subscriptions->portal($subscription, $user));
        } catch (StripeException $exception) {
            throw new ServiceUnavailableHttpException(30, 'Stripe could not be reached; try again.', $exception);
        }
    }
}
