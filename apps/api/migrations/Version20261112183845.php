<?php

declare(strict_types=1);

namespace DoctrineMigrations;

use Doctrine\DBAL\Schema\Schema;
use Doctrine\Migrations\AbstractMigration;

/**
 * Whether a chat account's relay finished its first import, so `firstImport` is honoured only during it. A new column
 * with a constant default on a small table: no rewrite, no long lock.
 */
final class Version20261112183845 extends AbstractMigration
{
    public function getDescription(): string
    {
        return 'Chat account: whether the relay finished importing its history';
    }

    public function up(Schema $schema): void
    {
        $this->addSql('ALTER TABLE chat_account ADD history_imported BOOLEAN DEFAULT false NOT NULL');
    }

    public function down(Schema $schema): void
    {
        $this->addSql('ALTER TABLE chat_account DROP history_imported');
    }
}
