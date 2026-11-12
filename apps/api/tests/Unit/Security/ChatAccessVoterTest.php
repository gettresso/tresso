<?php

declare(strict_types=1);

namespace App\Tests\Unit\Security;

use App\Entity\User;
use App\Security\ChatAccessVoter;
use App\Security\PersonalAccessToken\PersonalAccessTokenAuthentication;
use League\Bundle\OAuth2ServerBundle\Security\Authentication\Token\OAuth2Token;
use PHPUnit\Framework\Attributes\DataProvider;
use PHPUnit\Framework\TestCase;
use Symfony\Component\Security\Core\Authentication\Token\TokenInterface;
use Symfony\Component\Security\Core\Authorization\Voter\VoterInterface;

/**
 * The one rule for who reaches WhatsApp chats.
 */
final class ChatAccessVoterTest extends TestCase
{
    /**
     * @return iterable<string, array{TokenInterface, array{read: bool, send: bool, manage: bool}}>
     */
    public static function callers(): iterable
    {
        yield 'our web app with mail scopes' => [self::oauth('web', ['mail:read', 'mail:write', 'mail:send']), ['read' => true, 'send' => true, 'manage' => true]];
        yield 'our desktop app reading only' => [self::oauth('desktop', ['mail:read']), ['read' => true, 'send' => false, 'manage' => false]];
        yield 'our mobile app without mail scopes' => [self::oauth('mobile', ['settings:read']), ['read' => false, 'send' => false, 'manage' => false]];
        yield 'an app that is not ours with every mail scope' => [self::oauth('mcp-client', ['mail:read', 'mail:write', 'mail:send']), ['read' => false, 'send' => false, 'manage' => false]];
        yield 'an app that is not ours with chat:read' => [self::oauth('mcp-client', ['chat:read']), ['read' => true, 'send' => false, 'manage' => false]];
        yield 'an app that is not ours with chat:send' => [self::oauth('mcp-client', ['chat:send']), ['read' => false, 'send' => true, 'manage' => false]];
        yield 'an app that is not ours with both chat scopes and mail:write' => [self::oauth('mcp-client', ['chat:read', 'chat:send', 'mail:write']), ['read' => true, 'send' => true, 'manage' => false]];
        yield 'a personal access token with mail scopes' => [new PersonalAccessTokenAuthentication(new User('kim@example.test', 'Kim'), '0190b4a0-0000-7000-8000-000000000000', ['mail:read', 'mail:write', 'mail:send']), ['read' => false, 'send' => false, 'manage' => false]];
    }

    /**
     * @param array{read: bool, send: bool, manage: bool} $expected
     */
    #[DataProvider('callers')]
    public function testDecidesWhoReachesChats(TokenInterface $token, array $expected): void
    {
        $voter = new ChatAccessVoter();
        $vote = static fn (string $attribute): bool => VoterInterface::ACCESS_GRANTED === $voter->vote($token, null, [$attribute]);

        self::assertSame($expected, ['read' => $vote(ChatAccessVoter::READ), 'send' => $vote(ChatAccessVoter::SEND), 'manage' => $vote(ChatAccessVoter::MANAGE)]);
    }

    public function testAbstainsOnOtherAttributes(): void
    {
        self::assertSame(VoterInterface::ACCESS_ABSTAIN, new ChatAccessVoter()->vote(self::oauth('web', ['mail:read']), null, ['ROLE_USER']));
    }

    /**
     * @param list<string> $scopes
     */
    private static function oauth(string $client, array $scopes): OAuth2Token
    {
        return new OAuth2Token(new User('kim@example.test', 'Kim'), 'access', $client, $scopes, 'ROLE_OAUTH2_');
    }
}
