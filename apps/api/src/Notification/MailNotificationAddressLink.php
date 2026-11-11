<?php

declare(strict_types=1);

namespace App\Notification;

/**
 * Mails the confirmation link for a user's pending notification address ({@see NotificationEmailAddress}); sent once
 * the change that made it pending committed, and handled at once (not routed to a transport).
 */
final readonly class MailNotificationAddressLink
{
    public function __construct(
        public string $userId,
        public string $address,
    ) {
    }
}
