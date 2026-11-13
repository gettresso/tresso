<?php

declare(strict_types=1);

namespace App\Chat;

/** Removes replies kept as cancelled once their claim is old enough ({@see ChatQueue::purgeCancelled()}). */
final readonly class PurgeCancelledReplies
{
}
