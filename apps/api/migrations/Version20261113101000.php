<?php

declare(strict_types=1);

namespace DoctrineMigrations;

use Doctrine\DBAL\Schema\Schema;
use Doctrine\Migrations\AbstractMigration;

/**
 * Meeting preferences: a new table, one row per user that changed them. Nothing existing is rewritten or locked.
 */
final class Version20261113101000 extends AbstractMigration
{
    public function getDescription(): string
    {
        return 'Meeting preferences: the own room link, the app per mail account and the guests switch';
    }

    public function up(Schema $schema): void
    {
        $this->addSql('CREATE TABLE meeting_preferences (own_link VARCHAR(2048) DEFAULT NULL, add_with_guests BOOLEAN DEFAULT true NOT NULL, defaults JSON DEFAULT \'{}\' NOT NULL, default_other VARCHAR(8) DEFAULT NULL, disabled JSON DEFAULT \'[]\' NOT NULL, updated_at TIMESTAMP(0) WITHOUT TIME ZONE NOT NULL, user_id UUID NOT NULL, PRIMARY KEY (user_id))');
        $this->addSql('ALTER TABLE meeting_preferences ADD CONSTRAINT FK_C551A880A76ED395 FOREIGN KEY (user_id) REFERENCES app_user (id) ON DELETE CASCADE NOT DEFERRABLE');
    }

    public function down(Schema $schema): void
    {
        $this->addSql('ALTER TABLE meeting_preferences DROP CONSTRAINT FK_C551A880A76ED395');
        $this->addSql('DROP TABLE meeting_preferences');
    }
}
