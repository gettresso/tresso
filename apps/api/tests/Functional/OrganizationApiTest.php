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

    public function testOwnPersonalOrganizationComesFirstThenOthersByJoinDate(): void
    {
        $lisa = $this->connection()->fetchOne("SELECT id FROM app_user WHERE email = 'lisa@example.test'");
        self::assertIsString($lisa);
        $later = $this->team('Support', [$this->kim->getId()->toRfc4122() => '2026-03-01 09:00:00', $lisa => '2026-01-01 09:00:00']);
        $earlier = $this->team('Sales', [$this->kim->getId()->toRfc4122() => '2026-02-01 09:00:00']);

        $organizations = $this->organizations('kim@example.test');

        self::assertSame(['Kim Visser', 'Sales', 'Support'], array_column($organizations, 'name'));
        self::assertSame([true, false, false], array_column($organizations, 'personal'));
        self::assertSame([$earlier, $later], \array_slice(array_column($organizations, 'id'), 1));
        self::assertSame([1, 1, 2], array_column($organizations, 'seats'), 'Seats are the members of each organization.');
        self::assertSame(['owner', 'member', 'member'], array_column($organizations, 'role'));
    }

    public function testAnotherUsersPersonalOrganizationIsNotPersonalToMe(): void
    {
        $kimsPersonal = $this->organizations('kim@example.test')[0]['id'] ?? null;
        self::assertIsString($kimsPersonal);
        $this->connection()->executeStatement(
            "INSERT INTO organization_member (id, role, joined_at, organization_id, user_id)
             SELECT uuidv7(), 'member', '2020-01-01 09:00:00', :organization, id FROM app_user WHERE email = 'lisa@example.test'",
            ['organization' => $kimsPersonal],
        );

        $organizations = $this->organizations('lisa@example.test');

        self::assertSame(['Lisa Bakker', 'Kim Visser'], array_column($organizations, 'name'), 'Her own comes first, though she joined Kim\'s earlier.');
        self::assertSame([true, false], array_column($organizations, 'personal'));
        self::assertSame(2, $organizations[1]['seats'] ?? null);
    }

    public function testATeamNeedsAName(): void
    {
        $this->expectExceptionMessageMatches('/organization_team_or_personal/');
        $this->connection()->executeStatement('INSERT INTO organization (id, name, created_at) VALUES (uuidv7(), NULL, NOW())');
    }

    public function testAPersonalOrganizationHasNoNameOfItsOwn(): void
    {
        $this->expectExceptionMessageMatches('/organization_team_or_personal/');
        $this->connection()->executeStatement(
            "UPDATE organization SET name = 'Kim Inc.' WHERE personal_owner_id = :user",
            ['user' => $this->kim->getId()->toRfc4122()],
        );
    }

    public function testCreatingAUserMakesThemOwnerOfTheirPersonalOrganization(): void
    {
        self::assertSame(1, $this->countRows(
            "SELECT COUNT(*) FROM organization o JOIN organization_member m ON m.organization_id = o.id AND m.user_id = o.personal_owner_id
             WHERE o.personal_owner_id = :user AND o.name IS NULL AND m.role = 'owner'",
            ['user' => $this->kim->getId()->toRfc4122()],
        ));
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

    /**
     * A team with members, each joined at the given time, as the teams feature will make them.
     *
     * @param array<string, string> $members joined-at time per user id
     */
    private function team(string $name, array $members): string
    {
        $id = $this->connection()->fetchOne('INSERT INTO organization (id, name, created_at) VALUES (uuidv7(), :name, NOW()) RETURNING id', ['name' => $name]);
        self::assertIsString($id);
        foreach ($members as $user => $joinedAt) {
            $this->connection()->executeStatement(
                "INSERT INTO organization_member (id, role, joined_at, organization_id, user_id) VALUES (uuidv7(), 'member', :joined, :organization, :user)",
                ['joined' => $joinedAt, 'organization' => $id, 'user' => $user],
            );
        }

        return $id;
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
