<?php

declare(strict_types=1);

namespace App\Billing\Stripe;

/**
 * Stripe could not be reached, refused a request, or answered with something unexpected. The message never contains
 * a key.
 */
final class StripeException extends \RuntimeException
{
    /** The HTTP status Stripe answered with; null when it could not be reached or answered unreadably. */
    public ?int $status = null;

    public static function refused(int $status, string $message): self
    {
        $exception = new self($message);
        $exception->status = $status;

        return $exception;
    }

    /** Stripe answered and said no: retrying the same request will not help. */
    public function isRefusal(): bool
    {
        return null !== $this->status && $this->status >= 400 && $this->status < 500 && 429 !== $this->status;
    }
}
