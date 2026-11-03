<?php

declare(strict_types=1);

namespace App\Mcp\Tools;

use App\Batch\BatchTimes;
use App\Enum\NotificationChannel;
use App\Mcp\Api;
use App\Mcp\Tool\Schema;
use App\Mcp\Tool\Tool;
use App\Mcp\Tool\ToolArguments;
use App\Mcp\Tool\ToolEffect;
use App\Mcp\Tool\ToolProvider;
use App\Security\Scope;
use Mcp\Exception\ToolCallException;

/**
 * When mail that can wait is delivered: the batch times (/api/v1/batch-delivery) and the daily brief
 * (/api/v1/daily-brief-settings). Both are saved whole (PUT); the update tools fill in what the caller leaves out
 * from the current settings, so they need settings:read as well.
 */
final readonly class DeliveryTools implements ToolProvider
{
    public function tools(): iterable
    {
        yield new Tool(
            name: 'get_batch_delivery',
            title: 'Get batch times',
            description: 'When the user\'s batches go out: the times of day (HH:MM, sorted), the time zone, whether the '
                .'user chose them (false: still the defaults 09:00 and 16:00 UTC) and the next batch. Mail of smart '
                .'inboxes with batchDelivery waits for the next of these times and then arrives at once, without a '
                .'notification in between.',
            scopes: [Scope::SettingsRead],
            effect: ToolEffect::Read,
            inputSchema: Schema::object(),
            run: static fn (ToolArguments $arguments, Api $api): array => $api->get('/batch-delivery'),
        );

        yield new Tool(
            name: 'update_batch_delivery',
            title: 'Change batch times',
            description: 'Sets the times of day the user\'s batches go out and/or their time zone; what is left out stays. '
                .'While the user still has the defaults (configured false in get_batch_delivery), give both: saving '
                .'one would fix the default of the other as the user\'s choice. Mail that waits moves to the new next '
                .'batch. Which smart inboxes deliver in batches is set per smart inbox (batchDelivery in '
                .'update_smart_inbox).',
            scopes: [Scope::SettingsRead, Scope::SettingsWrite],
            effect: ToolEffect::Update,
            inputSchema: Schema::object([
                'times' => Schema::list(
                    Schema::timeOfDay('A time of day.'),
                    \sprintf('The times of day, 1 to %d, each once.', BatchTimes::MAX_TIMES),
                    1,
                    BatchTimes::MAX_TIMES,
                    true,
                ),
                'timeZone' => Schema::string('An IANA time zone, such as Europe/Amsterdam.'),
            ]),
            run: static function (ToolArguments $arguments, Api $api): array {
                if (!$arguments->has('times') && !$arguments->has('timeZone')) {
                    throw new ToolCallException('Give times, timeZone or both.');
                }
                $current = $api->get('/batch-delivery');
                // The API saves times and zone together and from then on counts both as chosen: without a choice yet,
                // filling in the default of the one left out would quietly make it the user's.
                if (true !== ($current['configured'] ?? null) && !($arguments->has('times') && $arguments->has('timeZone'))) {
                    throw new ToolCallException(\sprintf(
                        'The user has not chosen batch times yet (the defaults are %s, %s). Give both times and timeZone, so neither default is saved as their choice.',
                        implode(' and ', BatchTimes::DEFAULT_TIMES),
                        BatchTimes::DEFAULT_TIME_ZONE,
                    ));
                }

                return $api->put('/batch-delivery', [
                    'times' => $arguments->has('times') ? $arguments->strings('times') : ($current['times'] ?? []),
                    'timeZone' => $arguments->has('timeZone') ? $arguments->string('timeZone') : ($current['timeZone'] ?? ''),
                ]);
            },
        );

        yield new Tool(
            name: 'get_daily_brief_settings',
            title: 'Get daily brief settings',
            description: 'Whether the user gets the daily brief of mail that is only to know, at what time (HH:MM in '
                .'their notification time zone), where it goes besides the app (phone, desktop, email), the address '
                .'the email goes to and when the next brief is made.',
            scopes: [Scope::SettingsRead],
            effect: ToolEffect::Read,
            inputSchema: Schema::object(),
            run: static fn (ToolArguments $arguments, Api $api): array => $api->get('/daily-brief-settings'),
        );

        yield new Tool(
            name: 'update_daily_brief_settings',
            title: 'Change daily brief settings',
            description: 'Switches the daily brief on or off, sets its time and/or where it goes besides the app; what is '
                .'left out stays. The time zone and email address are those of the notification settings.',
            scopes: [Scope::SettingsRead, Scope::SettingsWrite],
            effect: ToolEffect::Update,
            inputSchema: Schema::object([
                'enabled' => Schema::boolean('Whether the user gets the daily brief.'),
                'deliverAt' => Schema::timeOfDay('When the brief is made, in the user\'s notification time zone.'),
                'channels' => Schema::list(
                    Schema::enum(NotificationChannel::values(), 'phone, desktop or email.'),
                    'Where the brief goes besides the app, which always shows it; an empty list: only the app.',
                    unique: true,
                ),
            ]),
            run: static function (ToolArguments $arguments, Api $api): array {
                $current = $api->get('/daily-brief-settings');

                return $api->put('/daily-brief-settings', [
                    'enabled' => $arguments->has('enabled') ? $arguments->get('enabled') : ($current['enabled'] ?? null),
                    'deliverAt' => $arguments->has('deliverAt') ? $arguments->get('deliverAt') : ($current['deliverAt'] ?? null),
                    'channels' => $arguments->has('channels') ? $arguments->strings('channels') : ($current['channels'] ?? null),
                ]);
            },
        );
    }
}
