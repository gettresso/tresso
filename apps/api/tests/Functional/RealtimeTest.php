<?php

declare(strict_types=1);

namespace App\Tests\Functional;

use App\Realtime\RealtimeNotifier;
use App\Realtime\MercureTokens;
use App\Repository\UserRepository;
use App\Sync\Change\ChangeSequencer;
use App\Tests\Support\RecordingMercureHub;
use Doctrine\ORM\EntityManagerInterface;
use Lcobucci\JWT\Encoding\JoseEncoder;
use Lcobucci\JWT\Signer\Hmac\Sha256;
use Lcobucci\JWT\Signer\Key\InMemory;
use Lcobucci\JWT\Token\Parser;
use Lcobucci\JWT\Token\Plain;
use Lcobucci\JWT\Validation\Constraint\SignedWith;
use Lcobucci\JWT\Validation\Validator;
use Symfony\Component\Uid\Uuid;

final class RealtimeTest extends DatabaseTestCase
{
    use AuthenticatesUsers;

    /** @var array<string, string> */
    private array $kim;

    protected function setUp(): void
    {
        parent::setUp();
        $this->bootstrapOAuthClients();
        $this->createUser('kim@example.test', 'Kim');
        $this->kim = $this->userHeaders('kim@example.test', ['mail:read', 'settings:write']);
        $this->hub()->takePublished();
    }

    public function testIssuesASubscriberTokenForTheUsersOwnTopic(): void
    {
        $this->client->request('GET', '/api/v1/realtime/token', server: $this->kim);

        self::assertResponseIsSuccessful();
        $topic = MercureTokens::changesTopic($this->kimId());
        self::assertSame($this->env('MERCURE_PUBLIC_URL'), $this->responseString('hubUrl'));
        self::assertSame($topic, $this->responseString('topic'));

        $jwt = $this->parse($this->responseString('token'));
        self::assertTrue(new Validator()->validate($jwt, new SignedWith(new Sha256(), InMemory::plainText($this->env('MERCURE_SUBSCRIBER_JWT_KEY')))));
        self::assertSame('at+jwt', $jwt->headers()->get('typ'));
        self::assertSame($this->kimId()->toRfc4122(), $jwt->claims()->get('sub'));
        self::assertSame('web', $jwt->claims()->get('client_id'));
        self::assertSame([['type' => MercureTokens::AUTHORIZATION_DETAIL_TYPE, 'actions' => ['subscribe'], 'topics' => [['match' => $topic, 'match_type' => 'exact']]]], $jwt->claims()->get('authorization_details'));
        self::assertEquals($jwt->claims()->get('exp'), new \DateTimeImmutable($this->responseString('expiresAt')));
        self::assertSame(40, $this->decodedResponse()['heartbeat'] ?? null);
    }

    public function testTokenRequiresMailReadScope(): void
    {
        $this->client->request('GET', '/api/v1/realtime/token', server: $this->userHeaders('kim@example.test', ['settings:read']));

        self::assertResponseStatusCodeSame(403);
    }

    public function testWorkersGetNoSubscriberToken(): void
    {
        $this->client->request('GET', '/api/v1/realtime/token', server: $this->workerHeaders('sync:lease sync:ingest'));

        self::assertResponseStatusCodeSame(403);
    }

    public function testCommittedChangesArePublishedAfterTheResponse(): void
    {
        $this->client->jsonRequest('POST', '/api/v1/mail-accounts', [
            'emailAddress' => 'kim@company.example',
            'displayName' => 'Work',
            'username' => 'kim@company.example',
            'password' => 'app-password-1',
            'imap' => ['host' => 'imap.company.example', 'port' => 993, 'security' => 'tls'],
            'smtp' => ['host' => 'smtp.company.example', 'port' => 465, 'security' => 'tls'],
        ], $this->kim);
        self::assertResponseIsSuccessful();

        $published = $this->hub()->takePublished();
        self::assertCount(1, $published);
        self::assertSame($this->env('MERCURE_INTERNAL_URL'), $published[0]['url']);
        self::assertSame(
            ['topic' => MercureTokens::changesTopic($this->kimId()), 'data' => json_encode(['cursor' => $this->cursor()]), 'private' => 'on', 'type' => 'changes'],
            $published[0]['body'],
        );

        self::assertStringStartsWith('Bearer ', $published[0]['authorization']);
        $jwt = $this->parse(substr($published[0]['authorization'], \strlen('Bearer ')));
        self::assertTrue(new Validator()->validate($jwt, new SignedWith(new Sha256(), InMemory::plainText($this->env('MERCURE_PUBLISHER_JWT_KEY')))));
        self::assertSame([['type' => MercureTokens::AUTHORIZATION_DETAIL_TYPE, 'actions' => ['publish'], 'topics' => [['match' => MercureTokens::changesTopic($this->kimId()), 'match_type' => 'exact']]]], $jwt->claims()->get('authorization_details'));
    }

    public function testReadsPublishNothing(): void
    {
        $this->client->request('GET', '/api/v1/sync/changes', server: $this->kim);
        self::assertResponseIsSuccessful();

        self::assertSame([], $this->hub()->takePublished());
    }

    public function testRolledBackChangesAreNotPublished(): void
    {
        $entityManager = static::getContainer()->get(EntityManagerInterface::class);
        $sequencer = static::getContainer()->get(ChangeSequencer::class);

        $kimId = $this->kimId();
        $failed = new \RuntimeException('Write failed.');
        try {
            $entityManager->wrapInTransaction(static function () use ($sequencer, $kimId, $failed): void {
                $sequencer->next($kimId);
                throw $failed;
            });
        } catch (\RuntimeException $caught) {
            self::assertSame($failed, $caught);
        }
        static::getContainer()->get(RealtimeNotifier::class)->publish();

        self::assertSame([], $this->hub()->takePublished());
    }

    public function testCommittedTransactionOutsideARequestIsPublishedOnPublish(): void
    {
        $sequencer = static::getContainer()->get(ChangeSequencer::class);
        $seq = static::getContainer()->get(EntityManagerInterface::class)->wrapInTransaction(fn (): int => $sequencer->next($this->kimId()));
        static::getContainer()->get(RealtimeNotifier::class)->publish();

        $published = $this->hub()->takePublished();
        self::assertCount(1, $published);
        self::assertSame(json_encode(['cursor' => $seq]), $published[0]['body']['data']);
    }

    private function hub(): RecordingMercureHub
    {
        return static::getContainer()->get(RecordingMercureHub::class);
    }

    private function kimId(): Uuid
    {
        $kim = static::getContainer()->get(UserRepository::class)->findOneByEmail('kim@example.test');
        self::assertNotNull($kim);

        return $kim->getId();
    }

    private function cursor(): int
    {
        $this->client->request('GET', '/api/v1/sync/changes', server: $this->kim);
        $cursor = $this->decodedResponse()['cursor'] ?? null;
        self::assertIsInt($cursor);

        return $cursor;
    }

    /** @return non-empty-string */
    private function env(string $name): string
    {
        $value = $_SERVER[$name] ?? null;
        if (!\is_string($value) || '' === $value) {
            self::fail(\sprintf('%s is not set.', $name));
        }

        return $value;
    }

    private function parse(string $token): Plain
    {
        if ('' === $token) {
            self::fail('Empty token.');
        }
        $jwt = new Parser(new JoseEncoder())->parse($token);
        self::assertInstanceOf(Plain::class, $jwt);

        return $jwt;
    }
}
