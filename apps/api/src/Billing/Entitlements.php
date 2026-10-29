<?php

declare(strict_types=1);

namespace App\Billing;

use Doctrine\DBAL\Connection;
use Psr\Clock\ClockInterface;
use Symfony\Component\Uid\Uuid;

/**
 * Whether a user may use this server: always when it does not bill, otherwise while at least one of their
 * organizations is in its trial or has a subscription Stripe still counts (trialing, active, or past due while Stripe
 * retries the payment). Everything that serves a user asks this: the API, the sync leases and the background jobs.
 */
final readonly class Entitlements
{
    /**
     * The rule in SQL, for a user id column or parameter named by `$user`; it needs the `now` and `paying` parameters
     * from {@see self::parameters()}.
     */
    public static function condition(string $user): string
    {
        return <<<SQL
            EXISTS (
                SELECT 1 FROM organization_member entitled_member
                JOIN billing_subscription entitled_subscription ON entitled_subscription.organization_id = entitled_member.organization_id
                WHERE entitled_member.user_id = {$user}
                  AND ((entitled_subscription.status = 'trial' AND entitled_subscription.trial_ends_at > :entitlement_now)
                       OR entitled_subscription.status = ANY(CAST(:entitlement_paying AS TEXT[])))
            )
            SQL;
    }

    public function __construct(
        private BillingSettings $settings,
        private Connection $connection,
        private ClockInterface $clock,
    ) {
    }

    public function billingEnabled(): bool
    {
        return $this->settings->enabled;
    }

    public function allows(Uuid $user): bool
    {
        if (!$this->settings->enabled) {
            return true;
        }

        return false !== $this->connection->fetchOne(
            'SELECT 1 WHERE '.self::condition(':user'),
            ['user' => $user->toRfc4122(), ...$this->parameters()],
        );
    }

    /** @return array{entitlement_now: string, entitlement_paying: string} */
    public function parameters(): array
    {
        return [
            'entitlement_now' => $this->clock->now()->setTimezone(new \DateTimeZone('UTC'))->format('Y-m-d H:i:s'),
            'entitlement_paying' => '{'.implode(',', SubscriptionStatus::payingValues()).'}',
        ];
    }
}
