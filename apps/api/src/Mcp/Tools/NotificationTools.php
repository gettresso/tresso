<?php

declare(strict_types=1);

namespace App\Mcp\Tools;

use App\Enum\NotificationChannel;
use App\Enum\NotificationKind;
use App\Enum\SnoozeChoice;
use App\Enum\TravelMode;
use App\Mcp\Api;
use App\Mcp\Tool\Schema;
use App\Mcp\Tool\Tool;
use App\Mcp\Tool\ToolArguments;
use App\Mcp\Tool\ToolEffect;
use App\Mcp\Tool\ToolProvider;
use App\Security\Scope;

/**
 * When and where the user is notified (/api/v1/notification-settings) and the devices that get push notifications
 * (/api/v1/notification-devices). Registering a device stays in Tresso's own apps.
 */
final readonly class NotificationTools implements ToolProvider
{
    private const array SETTINGS = [
        'timeZone', 'quietHoursEnabled', 'quietDays', 'quietStart', 'quietEnd', 'focusDuringBusy', 'emailAddress',
        'workDays', 'workStart', 'workEnd', 'shiftEarlyReminders', 'workCalendarsQuiet', 'holdDuringFocus',
        'holdMailInMeetings', 'mailPreviews', 'leaveNow', 'travelMode', 'extraTravelMinutes', 'snoozeChoices',
        'channelsByKind',
    ];

    private const string DEVICE_ID = 'The id of the device, from list_notification_devices.';

    public function tools(): iterable
    {
        yield new Tool(
            name: 'get_notification_settings',
            title: 'Get notification settings',
            description: 'When and where the user gets notifications: time zone, quiet hours, working hours, focus and '
                .'meeting behaviour, the address for email notifications, mail previews, leave-now alerts and travel, '
                .'snooze choices and the channels chosen per kind of notification (channelsByKind; kinds left out use '
                .'their default).',
            scopes: [Scope::SettingsRead],
            effect: ToolEffect::Read,
            inputSchema: Schema::object(),
            run: static fn (ToolArguments $arguments, Api $api): array => $api->get('/notification-settings'),
        );

        yield new Tool(
            name: 'update_notification_settings',
            title: 'Change notification settings',
            description: 'Changes notification settings. Only the fields given change.',
            scopes: [Scope::SettingsWrite],
            effect: ToolEffect::Update,
            inputSchema: Schema::object([
                'timeZone' => Schema::string('The user\'s IANA time zone, such as Europe/Amsterdam; quiet and working hours are in it.'),
                'quietHoursEnabled' => Schema::boolean('Whether notifications are silent during the quiet hours.'),
                'quietDays' => self::days('ISO days the quiet hours start on (1 = Monday, 7 = Sunday).'),
                'quietStart' => Schema::timeOfDay('When the quiet hours start.'),
                'quietEnd' => Schema::timeOfDay('When the quiet hours end; past midnight means the next day.'),
                'focusDuringBusy' => Schema::boolean('While a busy event runs, only the user\'s own meetings and leave-now alerts come through.'),
                'emailAddress' => Schema::string('Where email notifications go. The sign-in address or a Google or Microsoft account\'s address counts at once; any other address gets a confirmation link and counts once the user confirms it (pendingEmailAddress until then; giving it again sends the link again). An empty string goes back to the sign-in address.', maxLength: 320),
                'workDays' => self::days('ISO days with working hours (1 = Monday, 7 = Sunday).'),
                'workStart' => Schema::timeOfDay('When the working day starts.'),
                'workEnd' => Schema::timeOfDay('When the working day ends.'),
                'shiftEarlyReminders' => Schema::boolean('A reminder that would come before the working day comes at the end of the working day before instead.'),
                'workCalendarsQuiet' => Schema::boolean('Notifications of work calendars wait for working hours, except leave-now and important events.'),
                'holdDuringFocus' => Schema::boolean('During a focus block, notifications wait until it ends; meetings with others and leave-now come through.'),
                'holdMailInMeetings' => Schema::boolean('Mail notifications wait while the user is in a meeting.'),
                'mailPreviews' => Schema::boolean('Mail notifications show the sender, subject and the start of the text; false shows only the account.'),
                'leaveNow' => Schema::boolean('Leave-now alerts for events with a place.'),
                'travelMode' => Schema::enum(TravelMode::values(), 'How the user travels to events, for leave-now alerts.'),
                'extraTravelMinutes' => Schema::integer('Minutes added to the travel time of leave-now alerts.', 0, 60),
                'snoozeChoices' => Schema::list(
                    Schema::enum(SnoozeChoice::values(), 'minutes_5, minutes_10, minutes_15, before_start (one minute before the event), start, or meeting_end (when the current meeting ends).'),
                    'What a reminder offers to snooze until, in this order.',
                    1,
                    6,
                ),
                'channelsByKind' => self::channelsByKind(),
            ]),
            run: static fn (ToolArguments $arguments, Api $api): array => $api->patch('/notification-settings', $arguments->only(self::SETTINGS)),
        );

        yield new Tool(
            name: 'list_notification_devices',
            title: 'List notification devices',
            description: 'The devices that get the user\'s push notifications: id, kind (web_push, expo for the phone '
                .'app, desktop), name, whether it is on, when it was added and last seen.',
            scopes: [Scope::SettingsRead],
            effect: ToolEffect::Read,
            inputSchema: Schema::object(),
            run: static fn (ToolArguments $arguments, Api $api): array => $api->get('/notification-devices'),
        );

        yield new Tool(
            name: 'update_notification_device',
            title: 'Rename or switch a notification device',
            description: 'Renames a notification device and/or switches its notifications on or off. Only the fields given change.',
            scopes: [Scope::SettingsWrite],
            effect: ToolEffect::Update,
            inputSchema: Schema::object([
                'id' => Schema::id(self::DEVICE_ID),
                'name' => Schema::string('A name the user recognizes the device by.', 1, 120),
                'enabled' => Schema::boolean('Whether this device gets notifications.'),
            ], ['id']),
            run: static fn (ToolArguments $arguments, Api $api): array => $api->patch('/notification-devices/'.$arguments->id('id'), $arguments->only(['name', 'enabled'])),
        );

        yield new Tool(
            name: 'delete_notification_device',
            title: 'Remove a notification device',
            description: 'Removes a device from the user\'s notifications for good. Only the app on that device can add it again.',
            scopes: [Scope::SettingsWrite],
            effect: ToolEffect::Delete,
            inputSchema: Schema::object(['id' => Schema::id(self::DEVICE_ID)], ['id']),
            run: static function (ToolArguments $arguments, Api $api): array {
                $id = $arguments->id('id');
                $api->delete('/notification-devices/'.$id);

                return ['deleted' => $id];
            },
        );
    }

    /**
     * @return array<string, mixed>
     */
    private static function days(string $description): array
    {
        return Schema::list(Schema::integer('An ISO day: 1 = Monday, 7 = Sunday.', 1, 7), $description, maxItems: 7, unique: true);
    }

    /**
     * @return array<string, mixed>
     */
    private static function channelsByKind(): array
    {
        $channels = Schema::nullable(Schema::list(
            Schema::enum(NotificationChannel::values(), 'phone, desktop or email.'),
            'The channels for this kind; an empty list sends none; null goes back to the default.',
            unique: true,
        ));

        $kinds = [];
        foreach (NotificationKind::withChosenChannels() as $kind) {
            $kinds[$kind] = $channels;
        }

        return Schema::object(
            $kinds,
            description: 'Where each kind of notification goes: leave_now (time to leave for an event), brief (who is '
                .'coming, before a meeting), follow_up (after a meeting), mail (new mail to do or hand over), '
                .'hand_over (nobody replied to a hand-over in time), daily_brief (the daily brief). Kinds left out stay '
                .'as they are. Reminders carry their own channels (see the reminder rules).',
        );
    }
}
