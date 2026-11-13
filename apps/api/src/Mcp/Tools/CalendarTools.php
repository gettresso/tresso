<?php

declare(strict_types=1);

namespace App\Mcp\Tools;

use App\Calendar\Assistant\SchedulingRules;
use App\Calendar\MeetingLinkAddress;
use App\Entity\MeetingPreferences;
use App\Enum\NotificationChannel;
use App\Enum\RuleRole;
use App\Mcp\Api;
use App\Mcp\Tool\Schema;
use App\Mcp\Tool\Tool;
use App\Mcp\Tool\ToolArguments;
use App\Mcp\Tool\ToolEffect;
use App\Mcp\Tool\ToolProvider;
use App\Security\Scope;

/**
 * The calendar settings: the user's calendars (/api/v1/calendars), what the meeting time finder keeps free
 * (/api/v1/calendar/scheduling-preferences), which app makes the meeting link of a new event
 * (/api/v1/calendar/meeting-preferences) and the reminder rules (/api/v1/reminder-rules). Events themselves are not
 * settings and have no tools here.
 */
final readonly class CalendarTools implements ToolProvider
{
    private const string CALENDAR_ID = 'The id of the calendar, from list_calendars.';
    private const string RULE_ID = 'The id of the reminder rule, from list_reminder_rules.';
    private const string MEETING_PREFERENCES = 'Which app makes the meeting link of a new event per mail account (meet, '
        .'teams, zoom, own or none), the user\'s own room link, and whether a link is added when guests are invited.';

    /** What PUT /reminder-rules/{id} takes: the rule as GET answers it, without its id. */
    private const array RULE_FIELDS = [
        'name', 'calendarId', 'allDay', 'role', 'withAttendees', 'withConference', 'withLocation', 'reminders',
        'leaveNow', 'briefMinutes', 'followUp', 'position',
    ];

    public function tools(): iterable
    {
        yield from $this->calendarTools();
        yield from $this->schedulingTools();
        yield from $this->reminderRuleTools();
    }

    /**
     * @return iterable<Tool>
     */
    private function calendarTools(): iterable
    {
        yield new Tool(
            name: 'list_calendars',
            title: 'List calendars',
            description: 'The user\'s calendars, at the provider of a mail account or local to Tresso (mailAccountId '
                .'null): id, name, color, time zone, whether it can be written to, is the default for new events, is '
                .'shown, is a work calendar, and its position.',
            scopes: [Scope::CalendarRead],
            effect: ToolEffect::Read,
            inputSchema: Schema::object(),
            run: static fn (ToolArguments $arguments, Api $api): array => $api->get('/calendars'),
        );

        yield new Tool(
            name: 'get_calendar',
            title: 'Get a calendar',
            description: 'One calendar, as list_calendars describes it.',
            scopes: [Scope::CalendarRead],
            effect: ToolEffect::Read,
            inputSchema: Schema::object(['id' => Schema::id(self::CALENDAR_ID)], ['id']),
            run: static fn (ToolArguments $arguments, Api $api): array => $api->get('/calendars/'.$arguments->id('id')),
        );

        yield new Tool(
            name: 'create_calendar',
            title: 'Create a calendar',
            description: 'Adds a calendar local to Tresso (not at a mail provider).',
            scopes: [Scope::CalendarWrite],
            effect: ToolEffect::Create,
            inputSchema: Schema::object([
                'name' => Schema::string('The name of the calendar.', 1, 255),
                'color' => self::color(),
            ], ['name']),
            run: static fn (ToolArguments $arguments, Api $api): array => $api->post('/calendars', $arguments->only(['name', 'color'])),
        );

        yield new Tool(
            name: 'update_calendar',
            title: 'Change a calendar',
            description: 'Changes how the user sees and uses a calendar: its color, whether it is shown, whether it is a '
                .'work calendar (its notifications keep to working hours) and whether new events and accepted '
                .'invitations go to it by default. The name can only change for calendars local to Tresso. Only the '
                .'fields given change; nothing is sent to the provider.',
            scopes: [Scope::CalendarWrite],
            effect: ToolEffect::Update,
            inputSchema: Schema::object([
                'id' => Schema::id(self::CALENDAR_ID),
                'name' => Schema::string('The new name; only for calendars local to Tresso.', 1, 255),
                'color' => self::color(),
                'visible' => Schema::boolean('Whether the calendar\'s events are shown.'),
                'work' => Schema::boolean('A work calendar keeps its notifications to the working hours.'),
                'isDefault' => Schema::boolean('true makes this the calendar new events and accepted invitations of its account (or of Tresso) go to.'),
            ], ['id']),
            run: static fn (ToolArguments $arguments, Api $api): array => $api->patch('/calendars/'.$arguments->id('id'), $arguments->only(['name', 'color', 'visible', 'work', 'isDefault'])),
        );

        yield new Tool(
            name: 'delete_calendar',
            title: 'Delete a calendar',
            description: 'Deletes a calendar local to Tresso for good, with its events. Calendars of a mail account are '
                .'removed at the provider, and the last Tresso calendar cannot be deleted.',
            scopes: [Scope::CalendarWrite],
            effect: ToolEffect::Delete,
            inputSchema: Schema::object(['id' => Schema::id(self::CALENDAR_ID)], ['id']),
            run: static function (ToolArguments $arguments, Api $api): array {
                $id = $arguments->id('id');
                $api->delete('/calendars/'.$id);

                return ['deleted' => $id];
            },
        );
    }

    /**
     * @return iterable<Tool>
     */
    private function schedulingTools(): iterable
    {
        yield new Tool(
            name: 'get_scheduling_preferences',
            title: 'Get scheduling preferences',
            description: 'What the meeting time finder keeps free besides the working hours of the notification '
                .'settings: minutes of buffer around busy time, travel minutes to and from events at a place, the '
                .'minimum notice from now, and whether open todos with a deadline and a duration get time planned '
                .'before their deadline (planTodos).',
            scopes: [Scope::SettingsRead],
            effect: ToolEffect::Read,
            inputSchema: Schema::object(),
            run: static fn (ToolArguments $arguments, Api $api): array => $api->get('/calendar/scheduling-preferences'),
        );

        yield new Tool(
            name: 'update_scheduling_preferences',
            title: 'Change scheduling preferences',
            description: 'Changes what the meeting time finder keeps free. Only the fields given change.',
            scopes: [Scope::SettingsWrite],
            effect: ToolEffect::Update,
            inputSchema: Schema::object([
                'bufferMinutes' => Schema::integer('Minutes kept free on both sides of busy time.', 0, SchedulingRules::MAX_BUFFER_MINUTES),
                'travelMinutes' => Schema::integer('Minutes kept free to and from events at a place that names no travel time of its own.', 0, SchedulingRules::MAX_TRAVEL_MINUTES),
                'minimumNoticeMinutes' => Schema::integer('Nothing is proposed sooner than this many minutes from now.', 0, SchedulingRules::MAX_NOTICE_MINUTES),
                'planTodos' => Schema::boolean('Open todos with a deadline and a duration get free time planned before their deadline.'),
            ]),
            run: static fn (ToolArguments $arguments, Api $api): array => $api->patch('/calendar/scheduling-preferences', $arguments->only(['bufferMinutes', 'travelMinutes', 'minimumNoticeMinutes', 'planTodos'])),
        );

        yield new Tool(
            name: 'get_meeting_preferences',
            title: 'Get meeting preferences',
            description: self::MEETING_PREFERENCES.' Also the apps this server can offer (apps).',
            scopes: [Scope::SettingsRead],
            effect: ToolEffect::Read,
            inputSchema: Schema::object(),
            run: static fn (ToolArguments $arguments, Api $api): array => $api->get('/calendar/meeting-preferences'),
        );

        yield new Tool(
            name: 'update_meeting_preferences',
            title: 'Change meeting preferences',
            description: self::MEETING_PREFERENCES.' Only the fields given change; defaults and disabled replace the '
                .'whole map or list.',
            scopes: [Scope::SettingsWrite],
            effect: ToolEffect::Update,
            inputSchema: Schema::object([
                'ownLink' => Schema::string('The user\'s own room link: https only, without a name or password in it. Every event that uses it gets this same link, so anyone who has it can enter the room. An empty string removes it.', null, MeetingLinkAddress::MAX_LENGTH),
                'addWithGuests' => Schema::boolean('Switch the meeting link on when the first guest is added to an event.'),
                'defaults' => [
                    'type' => 'object',
                    'description' => 'The app per mail account (an id from list_mail_accounts) for events on that account\'s calendars.',
                    'propertyNames' => Schema::id('A mail account id, from list_mail_accounts.'),
                    'additionalProperties' => Schema::enum(MeetingPreferences::DEFAULTS, 'meet, teams, zoom, own or none.'),
                ],
                'defaultOther' => Schema::enum(MeetingPreferences::DEFAULTS, 'The app for calendars without a default of their own (Tresso calendars, new accounts).'),
                'disabled' => Schema::list(
                    Schema::object([
                        'app' => Schema::enum(MeetingPreferences::SWITCHABLE, 'meet (only for a Google account) or teams (only for a Microsoft account).'),
                        'mailAccountId' => Schema::id('The mail account, from list_mail_accounts.'),
                    ], ['app', 'mailAccountId']),
                    'Apps switched off in Tresso for one mail account.',
                ),
            ]),
            run: static fn (ToolArguments $arguments, Api $api): array => $api->patch('/calendar/meeting-preferences', $arguments->only(['ownLink', 'addWithGuests', 'defaults', 'defaultOther', 'disabled'])),
        );
    }

    /**
     * @return iterable<Tool>
     */
    private function reminderRuleTools(): iterable
    {
        yield new Tool(
            name: 'list_reminder_rules',
            title: 'List reminder rules',
            description: 'The rules that give reminders to events without reminders of their own, by calendar and kind '
                .'of event; the rule that sets the most conditions wins, ties go to the lowest position. Each rule '
                .'also switches leave-now alerts, the meeting brief and the follow-up for the events it matches.',
            scopes: [Scope::SettingsRead],
            effect: ToolEffect::Read,
            inputSchema: Schema::object(),
            run: static fn (ToolArguments $arguments, Api $api): array => $api->get('/reminder-rules'),
        );

        yield new Tool(
            name: 'get_reminder_rule',
            title: 'Get a reminder rule',
            description: 'One reminder rule, as list_reminder_rules describes it.',
            scopes: [Scope::SettingsRead],
            effect: ToolEffect::Read,
            inputSchema: Schema::object(['id' => Schema::id(self::RULE_ID)], ['id']),
            run: static fn (ToolArguments $arguments, Api $api): array => $api->get('/reminder-rules/'.$arguments->id('id')),
        );

        yield new Tool(
            name: 'create_reminder_rule',
            title: 'Create a reminder rule',
            description: 'Adds a reminder rule. Conditions left out match every event.',
            scopes: [Scope::SettingsWrite],
            effect: ToolEffect::Create,
            inputSchema: Schema::object(self::ruleProperties(), ['name']),
            run: static fn (ToolArguments $arguments, Api $api): array => $api->post('/reminder-rules', $arguments->only(self::RULE_FIELDS)),
        );

        yield new Tool(
            name: 'update_reminder_rule',
            title: 'Change a reminder rule',
            description: 'Changes a reminder rule; the fields left out stay as they are. Give null for a condition to '
                .'make it match every event again; reminders replaces the whole list.',
            scopes: [Scope::SettingsRead, Scope::SettingsWrite],
            effect: ToolEffect::Update,
            inputSchema: Schema::object(['id' => Schema::id(self::RULE_ID)] + self::ruleProperties(), ['id']),
            run: static function (ToolArguments $arguments, Api $api): array {
                $id = $arguments->id('id');
                $rule = array_intersect_key($api->get('/reminder-rules/'.$id), array_flip(self::RULE_FIELDS));

                return $api->put('/reminder-rules/'.$id, $arguments->only(self::RULE_FIELDS) + $rule);
            },
        );

        yield new Tool(
            name: 'delete_reminder_rule',
            title: 'Delete a reminder rule',
            description: 'Deletes a reminder rule for good; the events it matched follow the other rules.',
            scopes: [Scope::SettingsWrite],
            effect: ToolEffect::Delete,
            inputSchema: Schema::object(['id' => Schema::id(self::RULE_ID)], ['id']),
            run: static function (ToolArguments $arguments, Api $api): array {
                $id = $arguments->id('id');
                $api->delete('/reminder-rules/'.$id);

                return ['deleted' => $id];
            },
        );
    }

    /**
     * @return array<string, array<string, mixed>>
     */
    private static function ruleProperties(): array
    {
        $condition = static fn (string $description): array => Schema::nullable(Schema::boolean($description.' Null: both.'));

        return [
            'name' => Schema::string('A name the user recognizes the rule by.', 1, 120),
            'calendarId' => Schema::nullable(Schema::id('Only events of this calendar (from list_calendars); null: every calendar.')),
            'allDay' => $condition('true: only all-day events; false: only timed events.'),
            'role' => Schema::enum(array_map(static fn (RuleRole $role): string => $role->value, RuleRole::cases()), '"organized": events the user organizes (or nobody is invited to); "invited": events the user is invited to and did not decline; "any": both.'),
            'withAttendees' => $condition('true: only events with other people; false: only events without.'),
            'withConference' => $condition('true: only events with an online meeting; false: only events without.'),
            'withLocation' => $condition('true: only events with a place; false: only events without.'),
            'reminders' => Schema::list(
                Schema::object([
                    'minutesBefore' => Schema::nullable(Schema::integer('Minutes before the start (0 is at the start, at most four weeks).', 0, 40320)),
                    'dayBeforeAt' => Schema::nullable(Schema::timeOfDay('For all-day events: a time on the day before.')),
                    'channels' => Schema::list(Schema::enum(NotificationChannel::values(), 'phone, desktop or email.'), 'Where the reminder goes.', 1, 3, true),
                ], description: 'One reminder: give minutesBefore or dayBeforeAt, not both.'),
                'The reminders the matching events get, at most 10.',
                maxItems: 10,
            ),
            'leaveNow' => Schema::boolean('A leave-now alert for matching events with a place.'),
            'briefMinutes' => Schema::nullable(Schema::integer('Minutes before a matching meeting to send its brief (who is coming, what was said); null: no brief.', 0, 1440)),
            'followUp' => Schema::boolean('A nudge for notes and follow-up after matching meetings.'),
            'position' => Schema::integer('Breaks ties between equally specific rules: the lowest wins.', 0),
        ];
    }

    /**
     * @return array<string, mixed>
     */
    private static function color(): array
    {
        return Schema::string('A color as #RRGGBB, such as #2F80ED.', pattern: '^#[0-9a-fA-F]{6}$');
    }
}
