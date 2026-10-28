<?php

declare(strict_types=1);

namespace App\Calendar\Assistant;

/** This server does not offer the feature; `GET /api/v1/calendar/capabilities` says so beforehand. */
final class AssistantUnavailable extends \RuntimeException
{
}
