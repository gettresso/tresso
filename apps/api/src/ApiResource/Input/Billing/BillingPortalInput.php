<?php

declare(strict_types=1);

namespace App\ApiResource\Input\Billing;

use Symfony\Component\Validator\Constraints as Assert;

final class BillingPortalInput
{
    #[Assert\NotBlank]
    #[Assert\Uuid]
    public string $organizationId = '';
}
