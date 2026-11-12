<?php

declare(strict_types=1);

namespace App\Tests\Functional;

use Doctrine\DBAL\Schema\Schema;
use Doctrine\Migrations\DependencyFactory;
use Doctrine\Migrations\Query\Query;
use Doctrine\Migrations\Version\Version;

/**
 * The index the orphan sweep reads is built without blocking `message`: its own migration, outside a transaction,
 * with CREATE INDEX CONCURRENTLY. The column comes first, in a migration that only changes the catalog.
 */
final class OrphanedMessageIndexTest extends DatabaseTestCase
{
    public function testTheColumnMigrationBuildsNoIndex(): void
    {
        $statements = $this->statements('DoctrineMigrations\Version20261111140000');

        self::assertSame(['ALTER TABLE message ADD orphaned_at TIMESTAMP(0) WITHOUT TIME ZONE DEFAULT NULL'], $statements);
    }

    public function testTheIndexIsBuiltConcurrentlyOutsideATransaction(): void
    {
        $migration = $this->dependencyFactory()->getMigrationRepository()->getMigration(new Version('DoctrineMigrations\Version20261111140100'))->getMigration();

        self::assertFalse($migration->isTransactional(), 'CREATE INDEX CONCURRENTLY cannot run inside a transaction.');
        self::assertSame([
            'DROP INDEX CONCURRENTLY IF EXISTS message_orphaned',
            'CREATE INDEX CONCURRENTLY message_orphaned ON message (mail_account_id, orphaned_at) WHERE (orphaned_at IS NOT NULL)',
        ], $this->statements('DoctrineMigrations\Version20261111140100'));
    }

    public function testTheMigratedIndexIsValidAndPartial(): void
    {
        $row = $this->connection()->fetchAssociative(
            "SELECT i.indisvalid AS valid, pg_get_indexdef(i.indexrelid) AS definition
             FROM pg_index i JOIN pg_class c ON c.oid = i.indexrelid
             WHERE c.relname = 'message_orphaned'",
        );

        self::assertIsArray($row, 'The migrations created the index.');
        self::assertTrue($row['valid']);
        self::assertIsString($row['definition']);
        self::assertStringContainsString('(mail_account_id, orphaned_at) WHERE (orphaned_at IS NOT NULL)', $row['definition']);
    }

    /**
     * @return list<string>
     */
    private function statements(string $version): array
    {
        $migration = $this->dependencyFactory()->getMigrationRepository()->getMigration(new Version($version))->getMigration();
        $migration->up(new Schema());

        return array_values(array_map(static fn (Query $query): string => $query->getStatement(), $migration->getSql()));
    }

    private function dependencyFactory(): DependencyFactory
    {
        $factory = static::getContainer()->get('doctrine.migrations.dependency_factory');
        self::assertInstanceOf(DependencyFactory::class, $factory);

        return $factory;
    }
}
