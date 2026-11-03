<?php

declare(strict_types=1);

namespace App\Mcp\Tools;

use App\Classification\SenderPattern;
use App\Entity\Category;
use App\Enum\Verdict;
use App\Mcp\Api;
use App\Mcp\Tool\Schema;
use App\Mcp\Tool\Tool;
use App\Mcp\Tool\ToolArguments;
use App\Mcp\Tool\ToolEffect;
use App\Mcp\Tool\ToolProvider;
use App\Security\Scope;

/**
 * Smart inboxes (/api/v1/smart-inboxes): how incoming mail is sorted, and which senders always or never land in each,
 * plus the sender rules the user made by moving mail (/api/v1/sender-rules).
 */
final readonly class SmartInboxTools implements ToolProvider
{
    private const string SMART_INBOX_ID = 'The id of the smart inbox, from list_smart_inboxes.';
    private const array FIELDS = ['name', 'verdict', 'instructions', 'includeSenders', 'excludeSenders', 'autoCreateTodo', 'batchDelivery'];
    private const string SENDER = 'An email address (anna@example.com) or a whole domain written as @example.com.';

    public function tools(): iterable
    {
        yield new Tool(
            name: 'list_smart_inboxes',
            title: 'List smart inboxes',
            description: 'The user\'s smart inboxes in their order: the built-in ones (builtin is spam, notification, '
                .'advertise, todo or informational) and the user\'s own (builtin null), each with its name, '
                .'instructions, the senders always included and always excluded, its verdict, whether "do" mail becomes '
                .'a todo, whether new mail waits for the next batch, and its position.',
            scopes: [Scope::SettingsRead],
            effect: ToolEffect::Read,
            inputSchema: Schema::object(),
            run: static fn (ToolArguments $arguments, Api $api): array => $api->get('/smart-inboxes'),
        );

        yield new Tool(
            name: 'get_smart_inbox',
            title: 'Get a smart inbox',
            description: 'One smart inbox, as list_smart_inboxes describes it.',
            scopes: [Scope::SettingsRead],
            effect: ToolEffect::Read,
            inputSchema: Schema::object(['id' => Schema::id(self::SMART_INBOX_ID)], ['id']),
            run: static fn (ToolArguments $arguments, Api $api): array => $api->get('/smart-inboxes/'.$arguments->id('id')),
        );

        yield new Tool(
            name: 'create_smart_inbox',
            title: 'Create a smart inbox',
            description: 'Adds a smart inbox of the user\'s own. Mail from includeSenders always lands in it, mail from '
                .'excludeSenders never does (that wins over everything else).',
            scopes: [Scope::SettingsWrite],
            effect: ToolEffect::Create,
            inputSchema: Schema::object([
                'name' => self::name(),
                'verdict' => self::verdict(),
                'instructions' => self::instructions(),
                'includeSenders' => self::senders('Senders whose mail always lands here.'),
                'excludeSenders' => self::senders('Senders whose mail never lands here.'),
                'autoCreateTodo' => self::autoCreateTodo(),
                'batchDelivery' => self::batchDelivery(),
            ], ['name', 'verdict']),
            run: static fn (ToolArguments $arguments, Api $api): array => $api->post('/smart-inboxes', $arguments->only(self::FIELDS)),
        );

        yield new Tool(
            name: 'update_smart_inbox',
            title: 'Change a smart inbox',
            description: 'Changes a smart inbox. Only the fields given change; includeSenders and excludeSenders replace '
                .'the whole list (to add or remove a few senders, use add_smart_inbox_senders or '
                .'remove_smart_inbox_senders). Built-in smart inboxes can be changed too.',
            scopes: [Scope::SettingsWrite],
            effect: ToolEffect::Update,
            inputSchema: Schema::object([
                'id' => Schema::id(self::SMART_INBOX_ID),
                'name' => self::name(),
                'verdict' => self::verdict(),
                'instructions' => self::instructions(),
                'includeSenders' => self::senders('The complete new list of senders whose mail always lands here.'),
                'excludeSenders' => self::senders('The complete new list of senders whose mail never lands here.'),
                'autoCreateTodo' => self::autoCreateTodo(),
                'batchDelivery' => self::batchDelivery(),
            ], ['id']),
            run: static fn (ToolArguments $arguments, Api $api): array => $api->patch('/smart-inboxes/'.$arguments->id('id'), $arguments->only(self::FIELDS)),
        );

        yield new Tool(
            name: 'delete_smart_inbox',
            title: 'Delete a smart inbox',
            description: 'Deletes one of the user\'s own smart inboxes for good; its conversations are sorted into the '
                .'other smart inboxes again and mail it held for a batch is delivered. Built-in smart inboxes cannot be '
                .'deleted.',
            scopes: [Scope::SettingsWrite],
            effect: ToolEffect::Delete,
            inputSchema: Schema::object(['id' => Schema::id(self::SMART_INBOX_ID)], ['id']),
            run: static function (ToolArguments $arguments, Api $api): array {
                $id = $arguments->id('id');
                $api->delete('/smart-inboxes/'.$id);

                return ['deleted' => $id];
            },
        );

        yield new Tool(
            name: 'add_smart_inbox_senders',
            title: 'Add senders to a smart inbox',
            description: 'Adds senders to the list of a smart inbox whose mail always lands there ("include", the '
                .'default) or never does ("exclude"). A sender added to one list is taken off the other. Senders '
                .'already on the list stay as they are.',
            scopes: [Scope::SettingsRead, Scope::SettingsWrite],
            effect: ToolEffect::Update,
            inputSchema: Schema::object([
                'id' => Schema::id(self::SMART_INBOX_ID),
                'senders' => self::senders('The senders to add.', 1),
                'list' => Schema::enum(['include', 'exclude'], '"include": their mail always lands here (default); "exclude": it never does.'),
            ], ['id', 'senders']),
            run: static function (ToolArguments $arguments, Api $api): array {
                $id = $arguments->id('id');
                $current = $api->get('/smart-inboxes/'.$id);
                $senders = self::normalized($arguments->strings('senders'));
                [$target, $other] = 'exclude' === $arguments->get('list') ? ['excludeSenders', 'includeSenders'] : ['includeSenders', 'excludeSenders'];

                return $api->patch('/smart-inboxes/'.$id, [
                    $target => self::union(self::listOf($current, $target), $senders),
                    $other => self::without(self::listOf($current, $other), $senders),
                ]);
            },
        );

        yield new Tool(
            name: 'remove_smart_inbox_senders',
            title: 'Remove senders from a smart inbox',
            description: 'Takes senders off the include and/or exclude list of a smart inbox, so its usual sorting '
                .'decides for their mail again. Senders not on the list are ignored.',
            scopes: [Scope::SettingsRead, Scope::SettingsWrite],
            effect: ToolEffect::Update,
            inputSchema: Schema::object([
                'id' => Schema::id(self::SMART_INBOX_ID),
                'senders' => self::senders('The senders to remove.', 1),
                'list' => Schema::enum(['include', 'exclude', 'both'], 'Which list to remove them from; "both" when left out.'),
            ], ['id', 'senders']),
            run: static function (ToolArguments $arguments, Api $api): array {
                $id = $arguments->id('id');
                $current = $api->get('/smart-inboxes/'.$id);
                $senders = self::normalized($arguments->strings('senders'));
                $list = $arguments->get('list') ?? 'both';
                $changes = [];
                if ('exclude' !== $list) {
                    $changes['includeSenders'] = self::without(self::listOf($current, 'includeSenders'), $senders);
                }
                if ('include' !== $list) {
                    $changes['excludeSenders'] = self::without(self::listOf($current, 'excludeSenders'), $senders);
                }

                return $api->patch('/smart-inboxes/'.$id, $changes);
            },
        );

        yield new Tool(
            name: 'get_smart_inbox_senders',
            title: 'Who sends mail to a smart inbox',
            description: 'What a smart inbox holds in numbers (conversations, messages, unread) and the senders with the '
                .'most conversations in it (at most 100), without the user\'s own addresses. Useful to decide which '
                .'senders to include in or exclude from it.',
            scopes: [Scope::MailRead],
            effect: ToolEffect::Read,
            inputSchema: Schema::object(['id' => Schema::id(self::SMART_INBOX_ID)], ['id']),
            run: static fn (ToolArguments $arguments, Api $api): array => $api->get('/smart-inboxes/'.$arguments->id('id').'/senders'),
        );

        yield new Tool(
            name: 'list_sender_rules',
            title: 'List sender rules',
            description: 'The rules the user made by moving mail of a sender to another smart inbox: the sender (an '
                .'address or @domain), the smart inbox their mail goes to, the verdict it gets (null: that smart '
                .'inbox\'s) and when the rule last changed.',
            scopes: [Scope::SettingsRead],
            effect: ToolEffect::Read,
            inputSchema: Schema::object(),
            run: static fn (ToolArguments $arguments, Api $api): array => $api->get('/sender-rules'),
        );

        yield new Tool(
            name: 'delete_sender_rule',
            title: 'Delete a sender rule',
            description: 'Forgets a sender rule, so the smart inboxes sort that sender\'s new mail again.',
            scopes: [Scope::SettingsWrite],
            effect: ToolEffect::Delete,
            inputSchema: Schema::object(['id' => Schema::id('The id of the sender rule, from list_sender_rules.')], ['id']),
            run: static function (ToolArguments $arguments, Api $api): array {
                $id = $arguments->id('id');
                $api->delete('/sender-rules/'.$id);

                return ['deleted' => $id];
            },
        );
    }

    /**
     * @param list<string> $senders
     *
     * @return list<string>
     */
    private static function normalized(array $senders): array
    {
        return array_values(array_unique(array_map(SenderPattern::normalize(...), $senders)));
    }

    /**
     * @param array<mixed> $smartInbox
     *
     * @return list<string>
     */
    private static function listOf(array $smartInbox, string $field): array
    {
        $list = $smartInbox[$field] ?? null;

        return \is_array($list) ? array_values(array_filter($list, \is_string(...))) : [];
    }

    /**
     * @param list<string> $current
     * @param list<string> $added
     *
     * @return list<string>
     */
    private static function union(array $current, array $added): array
    {
        return array_values(array_unique([...$current, ...$added]));
    }

    /**
     * @param list<string> $current
     * @param list<string> $removed
     *
     * @return list<string>
     */
    private static function without(array $current, array $removed): array
    {
        return array_values(array_diff($current, $removed));
    }

    /**
     * @return array<string, mixed>
     */
    private static function name(): array
    {
        return Schema::string('The name shown in the mailbox list.', 1, Category::NAME_MAX_LENGTH);
    }

    /**
     * @return array<string, mixed>
     */
    private static function verdict(): array
    {
        return Schema::enum(
            Verdict::values(),
            'What mail here asks of the user: "do" (something to act on), "delegate" (to hand over to someone), "know" '
            .'(only to read) or "none" (nothing).',
        );
    }

    /**
     * @return array<string, mixed>
     */
    private static function instructions(): array
    {
        return Schema::string(
            'What belongs here, in plain words. Kept for AI sorting; the include and exclude lists are what sort mail today.',
            maxLength: Category::INSTRUCTIONS_MAX_LENGTH,
        );
    }

    /**
     * @return array<string, mixed>
     */
    private static function senders(string $description, ?int $minItems = null): array
    {
        return Schema::list(
            Schema::string(self::SENDER, pattern: trim(SenderPattern::REGEX, '/')),
            $description.' Each one an email address or @domain.',
            $minItems,
            Category::SENDERS_MAX_COUNT,
        );
    }

    /**
     * @return array<string, mixed>
     */
    private static function autoCreateTodo(): array
    {
        return Schema::boolean('New mail judged "do" here becomes a todo. Only with the "do" verdict; another verdict switches it off.');
    }

    /**
     * @return array<string, mixed>
     */
    private static function batchDelivery(): array
    {
        return Schema::boolean('New mail here waits for the user\'s next batch time (see get_batch_delivery) instead of arriving right away.');
    }
}
