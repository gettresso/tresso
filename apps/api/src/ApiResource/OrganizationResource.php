<?php

declare(strict_types=1);

namespace App\ApiResource;

use ApiPlatform\Metadata\ApiProperty;
use ApiPlatform\Metadata\ApiResource;
use ApiPlatform\Metadata\GetCollection;
use App\Entity\OrganizationMember;
use App\State\OrganizationProvider;

/**
 * An organization the signed-in user belongs to: always their own personal one, first, and any others they joined.
 * Like /me, only user tokens qualify.
 */
#[ApiResource(
    shortName: 'Organization',
    routePrefix: '/api/v1',
    operations: [
        new GetCollection(
            uriTemplate: '/organizations',
            paginationEnabled: false,
            security: "is_granted('IS_AUTHENTICATED_FULLY')",
            provider: OrganizationProvider::class,
        ),
    ],
)]
final readonly class OrganizationResource
{
    public function __construct(
        #[ApiProperty(identifier: true)]
        public string $id,
        /** A personal organization goes by its owner's display name. */
        public string $name,
        /** Whether this is the signed-in user's own personal organization. */
        public bool $personal,
        /** The signed-in user's role: `owner`, `admin` or `member`. */
        public string $role,
        /** Its members, which are the seats it pays for. */
        public int $seats,
        public \DateTimeImmutable $createdAt,
    ) {
    }

    public static function fromMembership(OrganizationMember $membership, int $seats): self
    {
        $organization = $membership->getOrganization();

        return new self(
            $organization->getId()->toRfc4122(),
            $organization->getName(),
            $organization->isPersonalOf($membership->getUser()),
            $membership->getRole()->value,
            $seats,
            $organization->getCreatedAt(),
        );
    }
}
