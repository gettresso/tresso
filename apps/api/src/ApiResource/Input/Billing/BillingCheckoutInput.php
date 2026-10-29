<?php

declare(strict_types=1);

namespace App\ApiResource\Input\Billing;

use Symfony\Component\Validator\Constraints as Assert;

final class BillingCheckoutInput
{
    #[Assert\NotBlank]
    #[Assert\Uuid]
    public string $organizationId = '';

    #[Assert\Choice(choices: ['monthly', 'yearly'])]
    public string $plan = 'monthly';
}
