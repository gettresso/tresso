<?php

declare(strict_types=1);

namespace App\Tests\Functional;

use App\Entity\User;
use App\Organization\PersonalOrganizations;
use Doctrine\DBAL\Exception\UniqueConstraintViolationException;
use Doctrine\ORM\EntityManagerInterface;

final class OrganizationApiTest extends DatabaseTestCase
{
    use AuthenticatesUsers;

    private User $kim;

    protected function setUp(): void
    {
        parent::setUp();
        $this->bootstrapOAuthClients();
        $this->kim = $this->createUser('kim@example.test', 'Kim Visser');
        $this->createUser('lisa@example.test', 'Lisa Bakker');
    }

    public function testANewUserOwnsOnePersonalOrganization(): void
    {
        $organizations = $this->organizations('kim@example.test');

        self::assertCount(1, $organizations);
        self::assertSame('Kim Visser', $organizations[0]['name'] ?? null);
        self::assertTrue($organizations[0]['personal'] ?? null);
        self::assertSame('owner', $organizations[0]['role'] ?? null);
        self::assertSame(1, $organizations[0]['seats'] ?? null);
        self::assertIsString($organizations[0]['createdAt'] ?? null);
    }

    public function testListsOnlyTheUsersOwnOrganizations(): void
    {
        $kim = array_column($this->organizations('kim@example.test'), 'id');
        $lisa = array_column($this->organizations('lisa@example.test'), 'id');

        self::assertCount(1, $kim);
        self::assertCount(1, $lisa);
        self::assertNotSame($kim, $lisa);
    }

    public function testAPersonalOrganizationFollowsItsOwnersName(): void
    {
        $this->kim->setDisplayName('Kim de Vries');
        static::getContainer()->get(EntityManagerInterface::class)->flush();

        self::assertSame('Kim de Vries', $this->organizations('kim@example.test')[0]['name'] ?? null);
    }

    public function testAUserHasOnlyOnePersonalOrganization(): void
    {
        static::getContainer()->get(PersonalOrganizations::class)->create($this->kim);

        $this->expectException(UniqueConstraintViolationException::class);
        static::getContainer()->get(EntityManagerInterface::class)->flush();
    }

    public function testWorkerTokensCannotReadOrganizations(): void
    {
        $this->client->request('GET', '/api/v1/organizations', server: $this->workerHeaders('sync:lease'));

        self::assertResponseStatusCodeSame(403);
    }

    public function testRequiresSignIn(): void
    {
        $this->client->request('GET', '/api/v1/organizations', server: ['HTTP_ACCEPT' => 'application/json']);

        self::assertResponseStatusCodeSame(401);
    }

    /** @return list<array<mixed>> */
    private function organizations(string $email): array
    {
        $this->client->request('GET', '/api/v1/organizations', server: $this->userHeaders($email, []));
        self::assertResponseIsSuccessful();

        $organizations = $this->decodedResponse();
        self::assertTrue(array_is_list($organizations));
        foreach ($organizations as $organization) {
            self::assertIsArray($organization);
        }

        /** @var list<array<mixed>> $organizations */
        return $organizations;
    }
}
