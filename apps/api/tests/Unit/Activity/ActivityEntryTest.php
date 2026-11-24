<?php

declare(strict_types=1);

namespace App\Tests\Unit\Activity;

use App\Activity\ActivityApp;
use App\Activity\ActivityChannel;
use App\Activity\ActivityEntry;
use App\Activity\ActivityKind;
use App\Activity\ActivityReason;
use App\Activity\ActivityResult;
use App\Activity\ApiOperation;
use App\Activity\ToolActivity;
use App\Mcp\ApiFailure;
use PHPUnit\Framework\Attributes\DataProvider;
use PHPUnit\Framework\TestCase;
use Symfony\Component\Uid\Uuid;

/**
 * An entry of the activity log only takes values shaped like what the log may keep, so content cannot get in by
 * mistake; and the reasons, kinds and scopes are read the same way everywhere.
 */
final class ActivityEntryTest extends TestCase
{
    public function testAToolCallAndAnApiRequestAreKept(): void
    {
        $tool = $this->entry(ActivityChannel::Mcp, null, 'send_whatsapp_message', 'Chat', 'b3f1c2d4-0000-7000-8000-000000000000');
        self::assertSame(['Chat', 'b3f1c2d4-0000-7000-8000-000000000000'], [$tool->objectType, $tool->objectId]);
        self::assertSame(ActivityResult::Done, $tool->result());

        $request = $this->entry(ActivityChannel::Api, 'PATCH', '/api/v1/mail-accounts/{id}', 'MailAccount', 'acc-1', ActivityReason::Unavailable);
        self::assertSame(ActivityResult::Failed, $request->result());
    }

    /**
     * @return iterable<string, array{ActivityChannel, ?string, string}>
     */
    public static function notAnAction(): iterable
    {
        yield 'a concrete path' => [ActivityChannel::Api, 'GET', '/api/v1/mail-accounts/0190b4a0-0000-7000-8000-000000000000'];
        yield 'a query string' => [ActivityChannel::Api, 'GET', '/api/v1/chats?q=secret'];
        yield 'a path outside the API' => [ActivityChannel::Api, 'GET', '/internal/sync/lease'];
        yield 'text' => [ActivityChannel::Mcp, null, 'Send "meet me at 5" to Anna'];
        yield 'an API request without its method' => [ActivityChannel::Api, null, '/api/v1/chats'];
        yield 'a tool call with a method' => [ActivityChannel::Mcp, 'POST', 'send_whatsapp_message'];
        yield 'an unknown method' => [ActivityChannel::Api, 'PURGE', '/api/v1/chats'];
    }

    #[DataProvider('notAnAction')]
    public function testAnythingButAToolNameOrARouteTemplateIsRefused(ActivityChannel $channel, ?string $method, string $action): void
    {
        $this->expectException(\InvalidArgumentException::class);
        $this->entry($channel, $method, $action);
    }

    public function testAnObjectThatIsNotANameAndAnIdIsLeftOut(): void
    {
        $entry = $this->entry(ActivityChannel::Api, 'GET', '/api/v1/chats/{id}', 'Chat', 'anna@partner.example');
        self::assertSame(['Chat', null], [$entry->objectType, $entry->objectId], 'An address is no id.');

        $entry = $this->entry(ActivityChannel::Api, 'GET', '/api/v1/chats/{id}', 'Chat with Anna', 'chat-1');
        self::assertSame([null, null], [$entry->objectType, $entry->objectId]);
    }

    public function testOnlyScopesAreKept(): void
    {
        $this->expectException(\InvalidArgumentException::class);
        new ActivityEntry(Uuid::v7(), new \DateTimeImmutable(), ActivityApp::client('claude'), ActivityChannel::Mcp, null, 'get_me', ActivityKind::Read, null, 1, ['read everything']);
    }

    public function testReasonsFollowTheStatus(): void
    {
        self::assertNull(ActivityReason::ofStatus(200));
        self::assertNull(ActivityReason::ofStatus(204));
        self::assertSame(ActivityReason::PaymentRequired, ActivityReason::ofStatus(402));
        self::assertSame(ActivityReason::NoPermission, ActivityReason::ofStatus(403));
        self::assertSame(ActivityReason::NotFound, ActivityReason::ofStatus(404));
        self::assertSame(ActivityReason::NotAccepted, ActivityReason::ofStatus(409));
        self::assertSame(ActivityReason::NotAccepted, ActivityReason::ofStatus(422));
        self::assertSame(ActivityReason::TooManyRequests, ActivityReason::ofStatus(429));
        self::assertSame(ActivityReason::Unavailable, ActivityReason::ofStatus(503));
        self::assertSame(ActivityReason::ServerError, ActivityReason::ofStatus(500));
        self::assertSame(ActivityResult::Refused, ActivityReason::TokenExpired->result());
        self::assertSame('No permission', ActivityReason::NoPermission->label());
        self::assertSame('Token expired', ActivityReason::TokenExpired->label());
    }

    public function testScopesAndKindComeFromTheSecurityExpression(): void
    {
        self::assertSame(['mail:read', 'calendar:write', 'mail:send'], ApiOperation::scopesOf("is_granted('ROLE_OAUTH2_MAIL:READ') and is_granted('ROLE_OAUTH2_CALENDAR:WRITE') and is_granted('ROLE_OAUTH2_MAIL:SEND')"));
        self::assertSame(['chat:send'], ApiOperation::scopesOf("is_granted('CHAT_SEND') and is_granted('FIRST_PARTY_CLIENT')"));
        self::assertSame([], ApiOperation::scopesOf("is_granted('CHAT_MANAGE')"));
        self::assertSame(ActivityKind::Send, ApiOperation::kindOf('POST', ['chat:send']));
        self::assertSame(ActivityKind::Send, ApiOperation::kindOf('POST', ['mail:read', 'mail:send']));
        self::assertSame(ActivityKind::Read, ApiOperation::kindOf('GET', ['chat:send']));
        self::assertSame(ActivityKind::Change, ApiOperation::kindOf('DELETE', ['mail:write']));
    }

    public function testAPathSegmentNamesItsResource(): void
    {
        self::assertSame('SmartInbox', ApiOperation::resourceOf('smart-inboxes'));
        self::assertSame('CalendarEvent', ApiOperation::resourceOf('calendar-events'));
        self::assertSame('Chat', ApiOperation::resourceOf('chats'));
        self::assertSame('ReminderRule', ApiOperation::resourceOf('reminder-rules'));
        self::assertSame('Category', ApiOperation::resourceOf('categories'));
        self::assertSame('Outgoing', ApiOperation::resourceOf('outgoing'));
    }

    public function testAToolThatFailsIsFailedAndOneWhoseServiceDidNotAnswerSaysSo(): void
    {
        self::assertSame(ActivityReason::Unavailable, ToolActivity::failureOf(new ApiFailure(503, 'The API answered 503.')));
        self::assertSame(ActivityReason::ServerError, ToolActivity::failureOf(new ApiFailure(500, 'The API answered 500.')));
        self::assertSame(ActivityReason::ServerError, ToolActivity::failureOf(new \RuntimeException('Something broke.')));
    }

    public function testAppKeys(): void
    {
        self::assertSame('client:claude-desktop', ActivityApp::fromKey('client:claude-desktop')?->key());
        self::assertSame('token:0190b4a0-0000-7000-8000-000000000000', ActivityApp::fromKey('token:0190B4A0-0000-7000-8000-000000000000')?->key());
        self::assertNull(ActivityApp::fromKey('token:not-a-uuid'));
        self::assertNull(ActivityApp::fromKey('client:'));
        self::assertNull(ActivityApp::fromKey('web'));
        self::assertFalse(ActivityApp::isLogged('web'));
        self::assertFalse(ActivityApp::isLogged('sync-worker'));
        self::assertTrue(ActivityApp::isLogged('claude-desktop'));
    }

    private function entry(ActivityChannel $channel, ?string $method, string $action, ?string $objectType = null, ?string $objectId = null, ?ActivityReason $reason = null): ActivityEntry
    {
        return new ActivityEntry(Uuid::v7(), new \DateTimeImmutable(), ActivityApp::client('claude'), $channel, $method, $action, ActivityKind::Read, $reason, 12, ['settings:read'], $objectType, false, $objectId);
    }
}
