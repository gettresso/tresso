<?php

declare(strict_types=1);

namespace App\Tests\Functional;

use App\Entity\MailAccount;
use App\Entity\User;
use App\Enum\MailAccountStatus;
use App\Enum\MailProvider;
use Doctrine\ORM\EntityManagerInterface;
use Symfony\Bundle\FrameworkBundle\Console\Application;
use Symfony\Component\Console\Tester\CommandTester;

final class SyncLeaseTest extends DatabaseTestCase
{
    protected function setUp(): void
    {
        parent::setUp();

        $kernel = $this->client->getKernel();
        $tester = new CommandTester(new Application($kernel)->find('app:oauth:bootstrap-clients'));
        $tester->execute([]);
        $tester->assertCommandIsSuccessful();
    }

    public function testRequiresToken(): void
    {
        $this->client->jsonRequest('POST', '/internal/sync/leases', ['workerId' => 'w1']);

        self::assertResponseStatusCodeSame(401);
    }

    public function testRequiresLeaseScope(): void
    {
        $this->client->jsonRequest('POST', '/internal/sync/leases', ['workerId' => 'w1'], $this->bearer('sync:ingest'));

        self::assertResponseStatusCodeSame(403);
    }

    public function testWorkerCannotRequestUserScopes(): void
    {
        $this->client->request('POST', '/oauth/token', [
            'grant_type' => 'client_credentials',
            'client_id' => 'sync-worker',
            'client_secret' => $this->secret(),
            'scope' => 'mail:read',
        ]);

        self::assertResponseStatusCodeSame(400);
    }

    public function testWorkerTokenCannotReadUserEndpoints(): void
    {
        $this->client->request('GET', '/api/v1/me', server: $this->bearer('sync:lease'));

        self::assertResponseStatusCodeSame(403);
    }

    public function testRejectsInvalidWorkerId(): void
    {
        $this->client->jsonRequest('POST', '/internal/sync/leases', ['workerId' => 'not valid!'], $this->bearer('sync:lease'));

        self::assertResponseStatusCodeSame(422);
    }

    public function testLeasesAreExclusiveRenewableAndReleasable(): void
    {
        $active = $this->createAccount('active@example.test', MailAccountStatus::Active);
        $this->createAccount('paused@example.test', MailAccountStatus::Paused);
        $auth = $this->bearer('sync:lease');

        self::assertSame([$active], $this->lease('w1', $auth), 'w1 claims the active account, paused is skipped');
        self::assertSame([], $this->lease('w2', $auth), 'w2 cannot claim an account w1 holds');
        self::assertSame([$active], $this->lease('w1', $auth), 'w1 renews its own lease');

        $this->client->jsonRequest('POST', '/internal/sync/leases/release', ['workerId' => 'w1'], $auth);
        self::assertResponseIsSuccessful();
        self::assertSame(['released' => 1], $this->json());

        self::assertSame([$active], $this->lease('w2', $auth), 'w2 takes over after release');
    }

    public function testAccountsWithASyncProblemKeepBeingRetried(): void
    {
        $failing = $this->createAccount('failing@example.test', MailAccountStatus::Error);
        $this->createAccount('refused@example.test', MailAccountStatus::AuthFailed);

        self::assertSame([$failing], $this->lease('w1', $this->bearer('sync:lease')), 'An error is retried; a refused login waits for a new password.');
    }

    public function testExpiredLeaseIsTakenOver(): void
    {
        $active = $this->createAccount('expired@example.test', MailAccountStatus::Active);
        $auth = $this->bearer('sync:lease');

        self::assertSame([$active], $this->lease('w1', $auth));
        $this->connection()->executeStatement("UPDATE mail_account SET lease_expires_at = now() - interval '1 minute'");

        self::assertSame([$active], $this->lease('w2', $auth));
        self::assertSame([], $this->lease('w1', $auth), 'w1 lost the account to w2');
    }

    public function testALeaseHoldsWhateverTimeZoneTheDatabaseSessionHas(): void
    {
        $active = $this->createAccount('zone@example.test', MailAccountStatus::Active);
        // West of UTC a lease written with the database clock looked expired at once to the PHP clock.
        $this->connection()->executeStatement("SET TIME ZONE 'America/New_York'");

        self::assertSame([$active], $this->lease('w1', $this->bearer('sync:lease')));
        $this->client->jsonRequest('POST', '/internal/sync/accounts/'.$active.'/status', ['workerId' => 'w1', 'status' => 'active'], $this->bearer('sync:ingest'));

        self::assertResponseIsSuccessful();
        self::assertSame([], $this->lease('w2', $this->bearer('sync:lease')), 'Nor can another worker take it over.');
    }

    public function testCapacityLimitsClaimedAccounts(): void
    {
        $this->createAccount('one@example.test', MailAccountStatus::Active);
        $this->createAccount('two@example.test', MailAccountStatus::Active);
        $auth = $this->bearer('sync:lease');

        self::assertCount(1, $this->lease('w1', $auth, 1));
        self::assertCount(1, $this->lease('w2', $auth, 5));
    }

    /**
     * @param array<string, string> $auth
     *
     * @return list<string> leased account ids
     */
    private function lease(string $workerId, array $auth, int $capacity = 10): array
    {
        $this->client->jsonRequest('POST', '/internal/sync/leases', ['workerId' => $workerId, 'capacity' => $capacity], $auth);
        self::assertResponseIsSuccessful();

        /** @var array{accounts: list<array{id: string}>} $body */
        $body = $this->json();

        return array_column($body['accounts'], 'id');
    }

    /** @return array<string, string> */
    private function bearer(string $scope): array
    {
        $this->client->request('POST', '/oauth/token', [
            'grant_type' => 'client_credentials',
            'client_id' => 'sync-worker',
            'client_secret' => $this->secret(),
            'scope' => $scope,
        ]);
        self::assertResponseIsSuccessful();

        /** @var array{access_token: string} $token */
        $token = $this->json();

        return ['HTTP_AUTHORIZATION' => 'Bearer '.$token['access_token']];
    }

    /** Same value the bootstrap command reads: a real env var wins over .env.test. */
    private function secret(): string
    {
        $secret = $_SERVER['SYNC_WORKER_CLIENT_SECRET'] ?? null;
        \assert(\is_string($secret) && '' !== $secret);

        return $secret;
    }

    /** @return array<mixed> */
    private function json(): array
    {
        $decoded = json_decode((string) $this->client->getResponse()->getContent(), true, flags: \JSON_THROW_ON_ERROR);
        \assert(\is_array($decoded));

        return $decoded;
    }

    private function createAccount(string $email, MailAccountStatus $status): string
    {
        $entityManager = static::getContainer()->get(EntityManagerInterface::class);

        $owner = new User('owner-'.$email, 'Owner');
        $account = new MailAccount($owner, $email, 'Test', MailProvider::Imap);
        $account->setStatus($status);
        $entityManager->wrapInTransaction(static function () use ($entityManager, $owner, $account): void {
            $entityManager->persist($owner);
            $entityManager->persist($account);
        });

        return $account->getId()->toRfc4122();
    }
}
